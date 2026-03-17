/**
 * Session Continuity Tests — Layer 4
 *
 * Validates that navigating between Board and Workspaces views does NOT reset
 * React state. The BoardWorkspaceHub keep-alive pattern mounts both surfaces
 * once and hides inactive ones with a CSS `hidden` class, preserving:
 *  - topic expansion state
 *  - in-progress chat drafts
 *  - the workspace panel's own state after first activation
 */

import { expect, test } from "@playwright/test";
import { waitForUnifiedViewReady } from "../visual/helpers";

test.describe("session continuity — Board ↔ Workspaces keep-alive", () => {
  test("topic expansion is preserved after Board → Workspaces → Board navigation", async ({
    page,
    request,
  }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `sc-expand-topic-${suffix}`;
    const topicName = `SC Expand Topic ${suffix}`;
    const taskId = `sc-expand-task-${suffix}`;
    const taskTitle = `SC Expand Task ${suffix}`;

    await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false, status: "active" },
    });
    await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
    });

    await page.goto("/u");
    await waitForUnifiedViewReady(page);

    // Expand the topic.
    const topicExpand = page
      .getByRole("button", { name: `Expand topic ${topicName}`, exact: true })
      .first();
    await expect(topicExpand).toBeVisible({ timeout: 20_000 });
    await topicExpand.click();

    // Verify expansion: collapse button is now visible, task card is visible.
    const topicCollapse = page
      .getByRole("button", { name: `Collapse topic ${topicName}`, exact: true })
      .first();
    await expect(topicCollapse).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`[data-task-card-id="${taskId}"]`).first()).toBeVisible();

    // Navigate to Workspaces.
    const workspacesLink = page.getByRole("link", { name: "Code Workspace" }).first();
    await expect(workspacesLink).toBeVisible();
    await workspacesLink.click();
    const workspacePanel = page.getByTestId("workspace-hub-panel");
    await expect(workspacePanel).toBeVisible({ timeout: 10_000 });

    // Board panel must still be attached (CSS hidden, not unmounted).
    const boardPanel = page.getByTestId("board-hub-panel");
    await expect(boardPanel).toBeAttached();

    // Navigate back to Board.
    const boardLink = page.getByRole("link", { name: "Unified View" }).first();
    await boardLink.click();
    await expect(boardPanel).toBeVisible({ timeout: 5_000 });

    // Topic must still be expanded — state survived the round-trip.
    await expect(topicCollapse).toBeVisible({ timeout: 5_000 });
    await expect(page.locator(`[data-task-card-id="${taskId}"]`).first()).toBeVisible();
  });

  test("chat composer draft text survives Board → Workspaces → Board", async ({
    page,
    request,
  }) => {
    const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://localhost:3051";
    const suffix = Date.now();
    const topicId = `sc-draft-topic-${suffix}`;
    const topicName = `SC Draft Topic ${suffix}`;
    const taskId = `sc-draft-task-${suffix}`;
    const taskTitle = `SC Draft Task ${suffix}`;
    const draftText = `unsent draft ${suffix}`;

    await request.post(`${apiBase}/api/topics`, {
      data: { id: topicId, name: topicName, pinned: false, status: "active" },
    });
    await request.post(`${apiBase}/api/tasks`, {
      data: { id: taskId, topicId, title: taskTitle, status: "todo", pinned: false },
    });

    await page.goto(`/u/topic/${topicId}/task/${taskId}`);
    await waitForUnifiedViewReady(page);

    // Find and type in the task chat composer for the target topic.
    const composer = page.getByTestId(`task-chat-composer-${topicId}`);
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const textbox = composer.getByRole("textbox");
    await textbox.fill(draftText);
    await expect(textbox).toHaveValue(draftText);

    // Navigate to Workspaces.
    const workspacesLink = page.getByRole("link", { name: "Code Workspace" }).first();
    await expect(workspacesLink).toBeVisible();
    await workspacesLink.click();
    await expect(page.getByTestId("workspace-hub-panel")).toBeVisible({ timeout: 10_000 });

    // Navigate back to Board.
    const boardLink = page.getByRole("link", { name: "Unified View" }).first();
    await boardLink.click();
    await expect(page.getByTestId("board-hub-panel")).toBeVisible({ timeout: 5_000 });

    // The draft text must still be in the composer.
    await expect(textbox).toHaveValue(draftText, { timeout: 5_000 });
  });

  test("workspace hub panel stays mounted once activated", async ({ page }) => {
    await page.goto("/u");
    await page.getByRole("heading", { name: "Unified View" }).waitFor({ timeout: 20_000 });

    // Workspace panel should not exist yet (demand-mount).
    const workspacePanel = page.getByTestId("workspace-hub-panel");
    await expect(workspacePanel).not.toBeAttached();

    // Navigate to Workspaces — panel mounts.
    const workspacesLink = page.getByRole("link", { name: "Code Workspace" }).first();
    await expect(workspacesLink).toBeVisible();
    await workspacesLink.click();
    await expect(workspacePanel).toBeAttached({ timeout: 10_000 });

    // Navigate back to Board — panel stays mounted but hidden.
    await page.getByRole("link", { name: "Unified View" }).first().click();
    await expect(page.getByTestId("board-hub-panel")).toBeVisible({ timeout: 5_000 });
    await expect(workspacePanel).toBeAttached();
    await expect(workspacePanel).toHaveClass(/hidden/, { timeout: 3_000 });

    // Navigate to Workspaces again — same mounted panel, now visible.
    await workspacesLink.click();
    await expect(workspacePanel).not.toHaveClass(/hidden/, { timeout: 5_000 });
  });
});
