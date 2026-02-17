import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

test("task snooze modal sets snoozedUntil and hides the task by default", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topic = { id: `task-snooze-topic-${suffix}`, name: `Task Snooze ${suffix}`, pinned: false };
  const task = {
    id: `task-snooze-task-${suffix}`,
    topicId: topic.id,
    title: `Snooze task ${suffix}`,
    status: "todo",
    pinned: false,
    priority: "medium",
  };

  const createTopic = await request.post(`${apiBase}/api/topics`, { data: topic });
  expect(createTopic.ok()).toBeTruthy();
  const createTask = await request.post(`${apiBase}/api/tasks`, { data: task });
  expect(createTask.ok()).toBeTruthy();

  await page.goto("/u");
  await page
    .locator('input[placeholder="Search topics, tasks, or messages"]:visible')
    .first()
    .waitFor();

  const topicCard = page.locator(`[data-topic-card-id="${topic.id}"]`).first();
  await expect(topicCard).toBeVisible();
  await topicCard.click();

  const taskCard = page.locator(`[data-task-card-id="${task.id}"]`).first();
  await expect(taskCard).toBeVisible();

  const swipeLeft = async (selector: string) => {
    const box = await page.locator(selector).first().boundingBox();
    expect(box).toBeTruthy();
    if (!box) return;
    const startX = box.x + box.width * 0.55;
    const endX = box.x + box.width * 0.2;
    const y = box.y + box.height * 0.5;

    await page.evaluate(
      ({ selector: s, startX: sx, endX: ex, y: cy }) => {
        const el = document.querySelector(s) as HTMLElement | null;
        if (!el) throw new Error(`Missing element: ${s}`);
        // Swipe handlers live on the SwipeRevealRow wrapper, not the card itself.
        const swipeTarget = (el.parentElement as HTMLElement | null) ?? el;
        const pointerId = 78;
        swipeTarget.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            pointerId,
            pointerType: "touch",
            clientX: sx,
            clientY: cy,
            isPrimary: true,
          })
        );
        for (let i = 1; i <= 8; i += 1) {
          const x = sx + ((ex - sx) * i) / 8;
          swipeTarget.dispatchEvent(
            new PointerEvent("pointermove", {
              bubbles: true,
              pointerId,
              pointerType: "touch",
              clientX: x,
              clientY: cy,
              isPrimary: true,
            })
          );
        }
        swipeTarget.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            pointerId,
            pointerType: "touch",
            clientX: ex,
            clientY: cy,
            isPrimary: true,
          })
        );
      },
      { selector, startX, endX, y }
    );
  };

  await swipeLeft(`[data-task-card-id="${task.id}"]`);

  const snoozeReq = page.waitForRequest((req) => {
    if (!req.url().includes("/api/tasks") || req.method() !== "POST") return false;
    try {
      const body = req.postDataJSON() as Record<string, unknown>;
      return body.id === task.id && typeof body.snoozedUntil === "string";
    } catch {
      return false;
    }
  });

  await page.getByRole("button", { name: /^SNOOZE$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /Tomorrow/i }).click();
  await snoozeReq;

  await expect(page.locator(`[data-task-card-id="${task.id}"]`)).toHaveCount(0);
});
