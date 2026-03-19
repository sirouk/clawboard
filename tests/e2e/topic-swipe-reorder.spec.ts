import { expect, test, type Page } from "@playwright/test";

async function swipeLeft(page: Page, selector: string) {
  let box: { x: number; y: number; width: number; height: number } | null = null;
  for (let i = 0; i < 8; i += 1) {
    const target = page.locator(selector).first();
    try {
      await target.waitFor({ state: "visible", timeout: 1200 });
      await target.scrollIntoViewIfNeeded();
      box = await target.boundingBox();
      if (box) break;
    } catch {
      // Topic rows can remount while filters/sse updates apply; retry against fresh locator.
    }
    await page.waitForTimeout(80);
  }
  expect(box).toBeTruthy();
  if (!box) return;
  const startX = box.x + box.width * 0.55;
  const endX = box.x + box.width * 0.2;
  const y = box.y + box.height * 0.5;

  await page.evaluate(
    ({ selector: s, startX: sx, endX: ex, y: cy }) => {
      const el = document.querySelector(s) as HTMLElement | null;
      if (!el) throw new Error(`Missing element: ${s}`);
      const swipeTarget = el;
      const pointerId = 77;
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
}

test("topic swipe actions (snooze/archive/delete) and reorder work in unified view", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const t1 = { id: `topic-swipe-a-${suffix}`, name: `Swipe A ${suffix}`, pinned: false };
  const t2 = { id: `topic-swipe-b-${suffix}`, name: `Swipe B ${suffix}`, pinned: false };

  const create1 = await request.post(`${apiBase}/api/topics`, { data: t1 });
  expect(create1.ok()).toBeTruthy();
  const create2 = await request.post(`${apiBase}/api/topics`, { data: t2 });
  expect(create2.ok()).toBeTruthy();

  await page.goto("/u");
  await page.getByRole("link", { name: "Board View" }).waitFor();

  const cardA = page.locator(`[data-topic-card-id="${t1.id}"]`).first();
  const cardB = page.locator(`[data-topic-card-id="${t2.id}"]`).first();
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeVisible();

  // Swipe left on Topic A to reveal actions.
  await swipeLeft(page, `[data-testid="topic-swipe-row-${t1.id}"]`);

  // Snooze should open a modal and then PATCH the topic with status snoozed and snoozedUntil.
  const snoozeReq = page.waitForRequest((req) => {
    if (!req.url().includes(`/api/topics/${encodeURIComponent(t1.id)}`) || req.method() !== "PATCH") return false;
    try {
      const body = req.postDataJSON() as Record<string, unknown>;
      return body.status === "snoozed" && typeof body.snoozedUntil === "string";
    } catch {
      return false;
    }
  });
  await page.getByRole("button", { name: /^SNOOZE$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: /Tomorrow/i }).click();
  await snoozeReq;

  // When not searching, snoozed topics are hidden from the unified list.
  await expect(page.locator(`[data-topic-card-id="${t1.id}"]`)).toHaveCount(0);

  // Make it visible via search, then swipe again and archive it.
  const composer = page.locator("[data-testid='unified-composer-textarea']:visible").first();
  await composer.fill(t1.name);
  const searchedCard = page.locator(`[data-topic-card-id="${t1.id}"]`).first();
  await expect(searchedCard).toBeVisible();

  await swipeLeft(page, `[data-testid="topic-swipe-row-${t1.id}"]`);

  const archiveReq = page.waitForRequest((req) => {
    if (!req.url().includes(`/api/topics/${encodeURIComponent(t1.id)}`) || req.method() !== "PATCH") return false;
    try {
      const body = req.postDataJSON() as Record<string, unknown>;
      return body.status === "archived";
    } catch {
      return false;
    }
  });
  await page.getByRole("button", { name: "ARCHIVE" }).click();
  await archiveReq;

  // Delete Topic A (confirm dialog).
  page.once("dialog", (dialog) => dialog.accept());
  const deleteResp = page.waitForResponse((resp) => {
    if (!resp.url().includes(`/api/topics/${encodeURIComponent(t1.id)}`)) return false;
    if (resp.request().method() !== "DELETE") return false;
    return true;
  });
  // Swipe once more to show delete (archive action closes tray).
  await swipeLeft(page, `[data-testid="topic-swipe-row-${t1.id}"]`);

  const deleteButton = page.getByRole("button", { name: /^DELETE$/ }).first();
  await expect(deleteButton).toBeVisible();
  await deleteButton.click();
  const resp = await deleteResp;
  expect(resp.ok()).toBeTruthy();
  const payload = (await resp.json().catch(() => null)) as { deleted?: boolean } | null;
  expect(payload?.deleted).toBeTruthy();

  // Topic A should be gone.
  await expect(page.locator(`[data-topic-card-id="${t1.id}"]`)).toHaveCount(0);

  // Reorder: drag grip for Topic B (only remaining of our pair) won't do much,
  // but should call reorder endpoint when pointer-up occurs over another card.
  // Create a third topic and then reorder B below it.
  const t3 = { id: `topic-swipe-c-${suffix}`, name: `Swipe C ${suffix}`, pinned: false };
  const create3 = await request.post(`${apiBase}/api/topics`, { data: t3 });
  expect(create3.ok()).toBeTruthy();

  await composer.fill("");
  const cardC = page.locator(`[data-topic-card-id="${t3.id}"]`).first();
  await expect(cardB).toBeVisible();
  await expect(cardC).toBeVisible();

  const reorderReq = page.waitForRequest((req) => req.url().includes("/api/topics/reorder") && req.method() === "POST");

  const gripB = page.getByTestId(`reorder-topic-${t2.id}`).first();
  await gripB.scrollIntoViewIfNeeded();
  await cardC.scrollIntoViewIfNeeded();
  await expect(gripB).toBeVisible();
  const gripBox = await gripB.boundingBox();
  const targetBox = await cardC.boundingBox();
  expect(gripBox).toBeTruthy();
  expect(targetBox).toBeTruthy();
  if (!gripBox || !targetBox) return;

  const startX = gripBox.x + gripBox.width / 2;
  const startY = gripBox.y + gripBox.height / 2;
  const endX = targetBox.x + targetBox.width / 2;
  const endY = targetBox.y + targetBox.height / 2;

  await page.evaluate(
    ({ startX: sx, startY: sy, endX: ex, endY: ey, testId }) => {
      const el = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
      if (!el) throw new Error(`Missing grip: ${testId}`);
      const pointerId = 88;
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId, clientX: sx, clientY: sy, isPrimary: true }));
      for (let i = 1; i <= 8; i += 1) {
        const x = sx + ((ex - sx) * i) / 8;
        const y = sy + ((ey - sy) * i) / 8;
        el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId, clientX: x, clientY: y, isPrimary: true }));
      }
      el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId, clientX: ex, clientY: ey, isPrimary: true }));
    },
    { startX, startY, endX, endY, testId: `reorder-topic-${t2.id}` }
  );

  await reorderReq;
});

test("topic snooze quick picks can be reconfigured before selecting one", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topic = { id: `topic-snooze-config-${suffix}`, name: `Snooze Config ${suffix}`, pinned: false };

  const createTopic = await request.post(`${apiBase}/api/topics`, { data: topic });
  expect(createTopic.ok()).toBeTruthy();

  await page.goto("/u");
  await page.getByRole("link", { name: "Board View" }).waitFor();
  await expect(page.locator(`[data-topic-card-id="${topic.id}"]`).first()).toBeVisible();

  await swipeLeft(page, `[data-testid="topic-swipe-row-${topic.id}"]`);
  await page.getByRole("button", { name: /^SNOOZE$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByRole("button", { name: /Tune quick picks/i }).click();
  await page.locator("#snooze-tomorrow-time").fill("13:45");

  const expectedTomorrowIso = await page.evaluate(() => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(13, 45, 0, 0);
    return tomorrow.toISOString();
  });

  const snoozeReq = page.waitForRequest((req) => {
    if (!req.url().includes(`/api/topics/${encodeURIComponent(topic.id)}`) || req.method() !== "PATCH") return false;
    try {
      const body = req.postDataJSON() as Record<string, unknown>;
      return body.status === "snoozed" && typeof body.snoozedUntil === "string";
    } catch {
      return false;
    }
  });

  await page.getByRole("button", { name: /Tomorrow/i }).click();
  const req = await snoozeReq;
  const body = req.postDataJSON() as Record<string, unknown>;
  expect(body.snoozedUntil).toBe(expectedTomorrowIso);
  await expect(page.locator(`[data-topic-card-id="${topic.id}"]`)).toHaveCount(0);
});

test("expanded topic swipe only moves the topic header, not the topic chat body", async ({ page, request }) => {
  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
  const suffix = Date.now();
  const topicId = `topic-swipe-expanded-${suffix}`;
  const topicName = `Swipe Expanded ${suffix}`;
  const longBody = "q".repeat(1800);

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const base = Date.now() - 10_000;
  const seedLogs = [
    { agentId: "user", content: `expanded-swipe-1-${suffix} ${longBody}`, createdAt: new Date(base).toISOString() },
    { agentId: "assistant", content: `expanded-swipe-2-${suffix} ${longBody}`, createdAt: new Date(base + 1000).toISOString() },
    { agentId: "user", content: `expanded-swipe-3-${suffix} ${longBody}`, createdAt: new Date(base + 2000).toISOString() },
    { agentId: "assistant", content: `expanded-swipe-4-${suffix} ${longBody}`, createdAt: new Date(base + 3000).toISOString() },
  ];
  for (const entry of seedLogs) {
    const response = await request.post(`${apiBase}/api/log`, {
      data: { topicId, type: "conversation", classificationStatus: "classified", ...entry },
    });
    expect(response.ok()).toBeTruthy();
  }

  await page.goto(`/u/topic/${topicId}`);
  await page.getByRole("link", { name: "Board View" }).waitFor();

  const swipeRow = page.getByTestId(`topic-swipe-row-${topicId}`).first();
  const translatedContent = swipeRow.locator(":scope > div").last();
  const body = page.getByTestId(`topic-expanded-body-${topicId}`).first();
  await expect(swipeRow).toBeVisible();
  await expect(translatedContent).toBeVisible();
  await expect(body).toBeVisible();

  const bodyBefore = await body.boundingBox();
  expect(bodyBefore).not.toBeNull();

  await swipeLeft(page, `[data-testid="topic-swipe-row-${topicId}"]`);

  const snoozeButton = page.getByRole("button", { name: /^SNOOZE$/ }).first();
  await expect(snoozeButton).toBeVisible();

  const contentTransform = await translatedContent.evaluate((node) => getComputedStyle(node).transform);
  const bodyAfter = await body.boundingBox();
  expect(bodyAfter).not.toBeNull();
  expect(contentTransform).not.toBe("none");
  expect(Math.abs((bodyAfter?.x ?? 0) - (bodyBefore?.x ?? 0))).toBeLessThan(8);
});
