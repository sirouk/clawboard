import { expect, test } from "@playwright/test";

test("logs page supports filters, grouping toggles, and semantic search hinting", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicA = { id: `topic-log-a-${suffix}`, name: `Logs A ${suffix}`, pinned: false };
  const topicB = { id: `topic-log-b-${suffix}`, name: `Logs B ${suffix}`, pinned: false };

  await request.post(`${apiBase}/api/topics`, { data: topicA });
  await request.post(`${apiBase}/api/topics`, { data: topicB });

  // Keep both entries on the same UTC day so the default "group by day" mode
  // doesn't collapse one of them behind an older day header.
  // Offset into the near-future so these appear near the top even when tests run in parallel.
  const baseTs = Date.now() + 5 * 60 * 1000;
  const noteAt = new Date(baseTs).toISOString();
  const convoAt = new Date(baseTs + 1000).toISOString();
  const noteText = `note-${suffix}-remember-to-test-filters`;
  const convoText = `convo-${suffix}-hello`;

  const noteRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: topicA.id,
      type: "note",
      content: noteText,
      summary: noteText,
      createdAt: noteAt,
      classificationStatus: "classified",
      agentId: "user",
      agentLabel: "User",
      source: { channel: "tests", sessionKey: `channel:log-${suffix}`, messageId: `m-note-${suffix}` },
    },
  });
  expect(noteRes.ok()).toBeTruthy();

  const convoRes = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId: topicB.id,
      type: "conversation",
      content: convoText,
      summary: convoText,
      createdAt: convoAt,
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { channel: "tests", sessionKey: `channel:log-${suffix}`, messageId: `m-convo-${suffix}` },
    },
  });
  expect(convoRes.ok()).toBeTruthy();

  await page.goto("/log");
  await expect(page.getByRole("heading", { name: "All Activity" })).toBeVisible();

  // Day headers should exist (grouped by day is on by default for the logs hopper).
  await expect(page.getByRole("button", { name: /Collapse day|Expand day/ }).first()).toBeVisible();

  // Text can appear both as the summary line and the body; assert at least one instance is visible.
  await expect(page.getByText(noteText, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(convoText, { exact: false }).first()).toBeVisible();

  // Type filter hides/show rows.
  await page.getByRole("combobox").first().selectOption("note");
  await expect(page.getByText(noteText, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(convoText, { exact: false })).toHaveCount(0);

  // Advanced filters include topic selection and lane chips.
  await page.getByRole("button", { name: "More filters" }).click();
  await page.getByRole("combobox").nth(2).selectOption(topicA.id);
  await page.getByRole("button", { name: "User" }).click();
  await expect(page.getByText(noteText, { exact: false }).first()).toBeVisible();
  await expect(page.getByText(convoText, { exact: false })).toHaveCount(0);

  // Semantic search hinting appears when searching.
  await page.getByPlaceholder("Search messages").fill("remember-to-test-filters");
  await expect(page.getByText(/Semantic search|Searching/i)).toBeVisible();

  // Grouping toggle collapses day headers.
  await page.getByRole("button", { name: "Ungrouped" }).click();
  await expect(page.getByRole("button", { name: /Collapse day|Expand day/ })).toHaveCount(0);
});
