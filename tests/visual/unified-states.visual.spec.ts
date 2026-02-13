import { expect, test } from "@playwright/test";
import { applyVisualStabilizers, gotoPath, openTask, openTopic } from "./helpers";

const TOPIC_NAME = "Clawboard";
const TOPIC_ID = "topic-1";
const TASK_NAME = "Ship onboarding wizard";
const TASK_ID = "task-1";

test.beforeEach(async ({ page }) => {
  await applyVisualStabilizers(page);
});

test("unified state: topic expanded", async ({ page }) => {
  await gotoPath(page, "/u");
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();
  await openTopic(page, TOPIC_NAME);
  await expect(page.getByPlaceholder("Add a task…")).toBeVisible();
  await expect(page).toHaveScreenshot("state-topic-expanded.png");
});

test("unified state: task expanded with chat visible", async ({ page }) => {
  await gotoPath(page, "/u");
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();
  await openTopic(page, TOPIC_NAME);
  await openTask(page, TASK_NAME);
  await expect(page.getByText("TASK CHAT")).toBeVisible();
  await expect(page).toHaveScreenshot("state-task-chat-visible.png");
});

test("unified state: topic chat expanded", async ({ page }) => {
  await gotoPath(page, "/u");
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();
  await openTopic(page, TOPIC_NAME);

  const toggle = page.getByTestId(`toggle-topic-chat-${TOPIC_ID}`);
  const label = ((await toggle.getAttribute("aria-label")) ?? "").toLowerCase();
  if (label.includes("expand")) {
    await toggle.click();
  }

  await expect(page.getByTestId(`topic-chat-scroll-${TOPIC_ID}`)).toBeVisible();
  await expect(page).toHaveScreenshot("state-topic-chat-visible.png");
});

test("unified state: mobile fullscreen task chat", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.use.isMobile, "Mobile-only snapshot.");

  await gotoPath(page, "/u");
  await page.getByPlaceholder("Search topics, tasks, or messages").waitFor();
  await openTopic(page, TOPIC_NAME);
  await openTask(page, TASK_NAME);

  await expect(page.locator(`[data-task-card-id='${TASK_ID}']`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Close chat" })).toBeVisible();
  await expect(page).toHaveScreenshot("state-mobile-task-chat-fullscreen.png");
});
