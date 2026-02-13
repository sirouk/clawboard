import { expect, test } from "@playwright/test";

test("clawgraph renders and supports interaction controls", async ({ page }) => {
  await page.goto("/graph");

  await expect(page.getByRole("heading", { name: "Clawgraph" })).toBeVisible();
  await expect(page.getByTestId("clawgraph-canvas")).toBeVisible();
  await expect(page.locator("[data-node-id]").first()).toBeVisible();

  await expect(page.getByRole("button", { name: "Show co-occur" })).toBeVisible();
  await page.getByRole("button", { name: "Show co-occur" }).click();
  await expect(page.getByRole("button", { name: "Hide co-occur" })).toBeVisible();

  await page.getByRole("button", { name: "Hide labels" }).click();
  await expect(page.getByRole("button", { name: "Show labels" })).toBeVisible();
  await page.getByRole("button", { name: "Show labels" }).click();

  const firstNode = page.locator("[data-node-id]").first();
  await expect(firstNode).toBeVisible();
  await firstNode.evaluate((node) => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  await expect(page.getByTestId("clawgraph-detail")).toContainText(/Score|size/i);
  await expect(page.getByTestId("clawgraph-detail")).toContainText(/Strongest links/i);

  await page.getByPlaceholder("Search entity, topic, task, or agent").fill("discord");
  await expect(page.getByText(/Query matches:/)).toBeVisible();

  const strongestLink = page.getByTestId("strongest-link-action").first();
  await expect(strongestLink).toBeVisible();
  await strongestLink.click();
  await expect(page).toHaveURL(/\/u\/?.*reveal=1/);
});

test("clawgraph node selection toggles off on second click", async ({ page }) => {
  await page.goto("/graph");
  await page.getByRole("heading", { name: "Clawgraph" }).waitFor();

  const firstNode = page.locator("[data-node-id]").first();
  await expect(firstNode).toBeVisible();
  await firstNode.evaluate((node) => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("clawgraph-detail")).toContainText(/Strongest links/i);

  await firstNode.evaluate((node) => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId("clawgraph-detail")).toContainText(/Select a node/i);
});
