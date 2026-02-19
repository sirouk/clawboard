import { expect, test } from "@playwright/test";

test("settings PWA notifications can be enabled and toggled", async ({ page }) => {
  await page.addInitScript(() => {
    type PwaProbe = {
      badgeCalls: number[];
    };
    const probe: PwaProbe = { badgeCalls: [] };
    (window as Window & { __clawPwaProbe?: PwaProbe }).__clawPwaProbe = probe;

    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    Object.defineProperty(nav, "setAppBadge", {
      configurable: true,
      writable: true,
      value: async (count?: number) => {
        probe.badgeCalls.push(typeof count === "number" ? count : 0);
      },
    });
    Object.defineProperty(nav, "clearAppBadge", {
      configurable: true,
      writable: true,
      value: async () => {
        probe.badgeCalls.push(0);
      },
    });

    class MockNotification {
      static permission = "default";

      static async requestPermission() {
        MockNotification.permission = "granted";
        return "granted";
      }

      constructor(_title?: string, _options?: Record<string, unknown>) {}

      addEventListener(_type: string, _listener: EventListenerOrEventListenerObject, _options?: AddEventListenerOptions | boolean) {}

      close() {}
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
    window.localStorage.removeItem("clawboard:push-enabled");
  });

  await page.goto("/settings");

  await expect(page.getByRole("heading", { name: "PWA Enhancements" })).toBeVisible();

  const enableButton = page.getByRole("button", { name: "Enable" });
  await expect(enableButton).toBeEnabled();
  await enableButton.click();

  await expect(page.getByText("Granted")).toBeVisible();

  const allowPushRow = page
    .getByRole("heading", { name: "Allow Push Notifications" })
    .locator("xpath=ancestor::div[1]/..");
  const pushSwitch = allowPushRow.getByRole("switch");

  await expect(pushSwitch).toBeEnabled();
  await expect(pushSwitch).toHaveAttribute("aria-checked", "true");

  await pushSwitch.click();
  await expect(pushSwitch).toHaveAttribute("aria-checked", "false");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("clawboard:push-enabled")))
    .toBe("false");

  await pushSwitch.click();
  await expect(pushSwitch).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("clawboard:push-enabled")))
    .toBe("true");

  const sendTestButton = page.getByRole("button", { name: "Send test in 3s" });
  await expect(sendTestButton).toBeEnabled();
  await sendTestButton.click();

  await expect(page.getByText("Scheduled. Sending in 3 seconds...")).toBeVisible();
  await expect(page.getByText("Test notification sent. Badge set to 1.")).toBeVisible({ timeout: 7_000 });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const probe = (window as Window & { __clawPwaProbe?: { badgeCalls: number[] } }).__clawPwaProbe;
          if (!probe || probe.badgeCalls.length === 0) return null;
          return probe.badgeCalls[probe.badgeCalls.length - 1] ?? null;
        }),
      { timeout: 7_000 }
    )
    .toBe(1);
  await expect.poll(() => page.title(), { timeout: 7_000 }).toMatch(/^\(1\)\s+/);

  await expect(page.getByText("Test notification sent. Badge set to 1.")).toBeVisible();
});

test("settings badging support does not trigger hydration mismatch", async ({ page }) => {
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (text.includes("Hydration failed because the server rendered text didn't match the client")) {
      hydrationErrors.push(text);
    }
  });

  await page.addInitScript(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };

    Object.defineProperty(nav, "setAppBadge", {
      configurable: true,
      writable: true,
      value: async (_count?: number) => undefined,
    });
    Object.defineProperty(nav, "clearAppBadge", {
      configurable: true,
      writable: true,
      value: async () => undefined,
    });
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "PWA Enhancements" })).toBeVisible();
  await expect(
    page
      .getByRole("heading", { name: "Unread Badge Count" })
      .locator("xpath=ancestor::div[1]/..")
      .getByText("Supported")
  ).toBeVisible();
  await expect.poll(() => hydrationErrors.length).toBe(0);
});

test("settings test button falls back to title badge when native badging is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    Object.defineProperty(nav, "setAppBadge", {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(nav, "clearAppBadge", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    class MockNotification {
      static permission = "default";

      static async requestPermission() {
        MockNotification.permission = "granted";
        return "granted";
      }

      constructor(_title?: string, _options?: Record<string, unknown>) {}

      addEventListener(_type: string, _listener: EventListenerOrEventListenerObject, _options?: AddEventListenerOptions | boolean) {}

      close() {}
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
    document.title = "Clawboard";
  });

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "PWA Enhancements" })).toBeVisible();

  const enableButton = page.getByRole("button", { name: "Enable" });
  await expect(enableButton).toBeEnabled();
  await enableButton.click();
  await expect(page.getByText("Granted")).toBeVisible();

  const sendTestButton = page.getByRole("button", { name: "Send test in 3s" });
  await expect(sendTestButton).toBeEnabled();
  await sendTestButton.click();

  await expect(page.getByText("Scheduled. Sending in 3 seconds...")).toBeVisible();
  await expect(page.getByText("Test notification sent. Badge set to 1.")).toBeVisible({ timeout: 7_000 });
  await expect.poll(() => page.title(), { timeout: 7_000 }).toMatch(/^\(1\)\s+/);
});
