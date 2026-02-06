import { expect, test } from "@playwright/test";

test("clawgraph renders and supports interaction controls", async ({ page }) => {
  await page.goto("/graph");

  await expect(page.getByRole("heading", { name: "Clawgraph" })).toBeVisible();
  await expect(page.getByTestId("clawgraph-canvas")).toBeVisible();
  await expect(page.locator("[data-node-id]").first()).toBeVisible();

  await page.getByRole("button", { name: "Hide co-occur" }).click();
  await expect(page.getByRole("button", { name: "Show co-occur" })).toBeVisible();
  await page.getByRole("button", { name: "Show co-occur" }).click();

  await page.getByRole("button", { name: "Hide labels" }).click();
  await expect(page.getByRole("button", { name: "Show labels" })).toBeVisible();
  await page.getByRole("button", { name: "Show labels" }).click();

  const firstNode = page.locator("[data-node-id]").first();
  await firstNode.click({ force: true });

  await expect(page.getByTestId("clawgraph-detail")).toContainText(/Score|size/i);
  await expect(page.getByTestId("clawgraph-detail")).toContainText(/Strongest links/i);

  await page.getByPlaceholder("Search entity, topic, task, or agent").fill("discord");
  await expect(page.getByText(/Query matches:/)).toBeVisible();
});
