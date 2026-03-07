import { expect, test } from "@playwright/test";
import { applyVisualStabilizers, gotoPath, openTask, openTopic, waitForUnifiedViewReady } from "./helpers";

const TOPIC_NAME = "Clawboard";
const TOPIC_ID = "topic-1";
const TASK_NAME = "Ship onboarding wizard";
const TASK_ID = "task-1";

test.beforeEach(async ({ page }) => {
  await applyVisualStabilizers(page);
});

test("unified state: topic expanded", async ({ page }) => {
  await gotoPath(page, "/u");
  await waitForUnifiedViewReady(page);
  await openTopic(page, TOPIC_NAME);
  await expect(page.getByPlaceholder("Add a task…")).toBeVisible();
  await expect(page).toHaveScreenshot("state-topic-expanded.png");
});

test("unified state: task expanded with chat visible", async ({ page }) => {
  await gotoPath(page, "/u");
  await waitForUnifiedViewReady(page);
  await openTopic(page, TOPIC_NAME);
  await openTask(page, TASK_NAME);
  await expect(page.getByText("TASK CHAT")).toBeVisible();
  await expect(page).toHaveScreenshot("state-task-chat-visible.png");
});

test("unified state: legacy inline chat controls absent", async ({ page }) => {
  await gotoPath(page, "/u");
  await waitForUnifiedViewReady(page);
  await openTopic(page, TOPIC_NAME);
  await expect(page.getByTestId(`toggle-topic-chat-${TOPIC_ID}`)).toHaveCount(0);
  await expect(page).toHaveScreenshot("state-topic-chat-absent.png");
});

test("unified state: mobile fullscreen task chat", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, "Mobile-only snapshot.");

  await gotoPath(page, "/u");
  await waitForUnifiedViewReady(page);
  await openTopic(page, TOPIC_NAME);
  await openTask(page, TASK_NAME);

  await expect(page.locator(`[data-task-card-id='${TASK_ID}']`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Close chat" })).toBeVisible();
  await expect(page).toHaveScreenshot("state-mobile-task-chat-fullscreen.png");
});
