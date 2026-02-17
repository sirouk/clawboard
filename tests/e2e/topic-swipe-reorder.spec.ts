import { expect, test } from "@playwright/test";

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
  await page.getByRole("heading", { name: "Unified View" }).waitFor();

  const cardA = page.locator(`[data-topic-card-id="${t1.id}"]`).first();
  const cardB = page.locator(`[data-topic-card-id="${t2.id}"]`).first();
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeVisible();

  const swipeLeft = async (selector: string) => {
    const target = page.locator(selector).first();
    await target.scrollIntoViewIfNeeded();
    await expect(target).toBeVisible();
    let box = await target.boundingBox();
    if (!box) {
      for (let i = 0; i < 5 && !box; i += 1) {
        await page.waitForTimeout(80);
        box = await target.boundingBox();
      }
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
        // Swipe handlers live on the SwipeRevealRow wrapper, not the card itself.
        const swipeTarget = (el.parentElement as HTMLElement | null) ?? el;
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
  };

  // Swipe left on Topic A to reveal actions.
  await swipeLeft(`[data-topic-card-id="${t1.id}"]`);

  // Snooze should open a modal and then POST /api/topics with status snoozed and snoozedUntil.
  const snoozeReq = page.waitForRequest((req) => {
    if (!req.url().includes("/api/topics") || req.method() !== "POST") return false;
    try {
      const body = req.postDataJSON() as Record<string, unknown>;
      return body.id === t1.id && body.status === "snoozed" && typeof body.snoozedUntil === "string";
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
  await page.getByPlaceholder("Search topics, tasks, or messages").fill(t1.name);
  const searchedCard = page.locator(`[data-topic-card-id="${t1.id}"]`).first();
  await expect(searchedCard).toBeVisible();

  await swipeLeft(`[data-topic-card-id="${t1.id}"]`);

  const archiveReq = page.waitForRequest((req) => {
    if (!req.url().includes("/api/topics") || req.method() !== "POST") return false;
    try {
      const body = req.postDataJSON() as Record<string, unknown>;
      return body.id === t1.id && body.status === "archived";
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
  await swipeLeft(`[data-topic-card-id="${t1.id}"]`);

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

  await page.getByPlaceholder("Search topics, tasks, or messages").fill("");
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
