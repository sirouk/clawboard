import { expect, test } from "@playwright/test";

test("stale topic upsert does not resurrect a deleted topic", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicSeed = { id: `topic-delete-regression-${suffix}`, name: `Delete Regression ${suffix}`, pinned: false };

  const createTopic = await request.post(`${apiBase}/api/topics`, { data: topicSeed });
  expect(createTopic.ok()).toBeTruthy();
  const topic = (await createTopic.json()) as { id: string; name: string; updatedAt?: string; createdAt?: string };

  await page.goto("/u");
  await page.getByRole("link", { name: "Board View" }).waitFor();
  const topicCard = page.locator(`[data-topic-card-id="${topic.id}"]`).first();
  await expect(topicCard).toBeVisible();

  const deleteTopic = await request.delete(`${apiBase}/api/topics/${encodeURIComponent(topic.id)}`);
  expect(deleteTopic.ok()).toBeTruthy();
  await expect(page.locator(`[data-topic-card-id="${topic.id}"]`)).toHaveCount(0, { timeout: 10_000 });

  const staleUpsert = await request.post(`${apiBase}/api/test/live-event`, {
    data: {
      type: "topic.upserted",
      data: topic,
      eventTs: topic.updatedAt ?? topic.createdAt,
    },
  });
  expect(staleUpsert.ok()).toBeTruthy();

  await expect(page.locator(`[data-topic-card-id="${topic.id}"]`)).toHaveCount(0, { timeout: 5_000 });
});
