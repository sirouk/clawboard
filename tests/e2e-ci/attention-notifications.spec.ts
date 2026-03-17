import { expect, test, type Page } from "@playwright/test";

type AttentionProbe = {
  badgeCalls: number[];
  notifications: Array<{ title: string; body: string; tag: string }>;
  closedTags: string[];
  visibility: "visible" | "hidden";
};

declare global {
  interface Window {
    __attentionProbe?: AttentionProbe;
  }
}

async function ensureBoardTopicsVisible(page: Page) {
  const search = page.getByPlaceholder(/Search topics/i);
  if ((await search.count()) > 0) {
    await expect(search).toBeVisible();
    return search;
  }

  const boardLink = page.getByRole("link", { name: "Board", exact: true });
  await expect(boardLink).toBeVisible();
  await boardLink.click();
  await expect(search).toBeVisible();
  return search;
}

async function probeSnapshot(page: Page) {
  return page.evaluate(() => {
    const probe = window.__attentionProbe;
    return {
      badgeCallCount: probe?.badgeCalls.length ?? 0,
      lastBadge: probe?.badgeCalls[probe.badgeCalls.length - 1] ?? 0,
      notifications: probe?.notifications ?? [],
      closedTags: probe?.closedTags ?? [],
    };
  });
}

test("topic activity notifications keep board badges and the app badge in sync", async ({ page, request }) => {
  await page.addInitScript(() => {
    const probe: AttentionProbe = {
      badgeCalls: [],
      notifications: [],
      closedTags: [],
      visibility: "visible",
    };
    window.__attentionProbe = probe;

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

    if ("serviceWorker" in navigator) {
      try {
        Object.defineProperty(navigator.serviceWorker, "ready", {
          configurable: true,
          get: () => Promise.resolve(null),
        });
      } catch {
        // Best-effort only. The notification fallback still works if this fails.
      }
    }

    class MockNotification {
      static permission: NotificationPermission = "granted";

      readonly tag: string;

      constructor(title: string, options?: NotificationOptions) {
        this.tag = String(options?.tag ?? "");
        probe.notifications.push({
          title,
          body: String(options?.body ?? ""),
          tag: this.tag,
        });
      }

      static async requestPermission() {
        return "granted" as const;
      }

      addEventListener() {}

      close() {
        if (this.tag) probe.closedTags.push(this.tag);
      }
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__attentionProbe?.visibility ?? "visible",
    });

    window.localStorage.setItem("clawboard:push-enabled", "true");
  });

  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://127.0.0.1:3151";
  const suffix = Date.now();
  const topicId = `topic-attention-${suffix}`;
  const topicName = `Attention Topic ${suffix}`;
  const sessionKey = `clawboard:topic:${topicId}`;
  const chatKey = `topic:${topicId}`;
  const notificationTag = `clawboard-chat-${chatKey}`;

  const createTopic = await request.post(`${apiBase}/api/topics`, {
    data: { id: topicId, name: topicName, status: "active", pinned: false },
  });
  expect(createTopic.ok()).toBeTruthy();

  const initialLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      type: "conversation",
      content: `Initial seen activity ${suffix}`,
      summary: `Initial seen activity ${suffix}`,
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(initialLog.ok()).toBeTruthy();

  await page.goto("/u");
  await expect(page.getByRole("button", { name: /Shuffle Board Colors/i })).toBeVisible();
  await ensureBoardTopicsVisible(page);

  const topicNavRow = page.locator(`[data-board-topic-id="${topicId}"]`);
  const topicCard = page.locator(`[data-topic-card-id="${topicId}"]`);
  const navAttentionBadge = topicNavRow.locator('[aria-label="1 topic needs a look"]');
  const cardAttentionBadge = topicCard.locator('[title="Topic needs a look"]');

  await expect(topicNavRow).toBeVisible();
  await expect(topicCard).toBeVisible();
  await expect(navAttentionBadge).toHaveCount(0);
  await expect(cardAttentionBadge).toHaveCount(0);
  await expect.poll(async () => (await probeSnapshot(page)).badgeCallCount).toBeGreaterThan(0);

  const baseline = await probeSnapshot(page);

  await page.evaluate(() => {
    if (window.__attentionProbe) {
      window.__attentionProbe.visibility = "hidden";
    }
  });

  const unreadLog = await request.post(`${apiBase}/api/log`, {
    data: {
      topicId,
      type: "conversation",
      content: `Unread activity ${suffix}`,
      summary: `Unread activity ${suffix}`,
      classificationStatus: "classified",
      agentId: "assistant",
      agentLabel: "OpenClaw",
      source: { sessionKey },
    },
  });
  expect(unreadLog.ok()).toBeTruthy();

  await expect(navAttentionBadge).toHaveCount(1);
  await expect(cardAttentionBadge).toHaveCount(1);
  await expect
    .poll(async () => {
      const probe = await probeSnapshot(page);
      return probe.notifications.some((item) => item.title === `Topic Activity: ${topicName}` && item.tag === notificationTag);
    })
    .toBe(true);
  await expect.poll(async () => (await probeSnapshot(page)).lastBadge).toBe(baseline.lastBadge + 1);

  await page.evaluate(
    ({ chatKey: notificationChatKey, topicId: notificationTopicId }) => {
      window.dispatchEvent(
        new CustomEvent("clawboard:notification-clicked", {
          detail: {
            chatKey: notificationChatKey,
            topicId: notificationTopicId,
          },
        })
      );
    },
    { chatKey, topicId }
  );

  await expect(navAttentionBadge).toHaveCount(0);
  await expect(cardAttentionBadge).toHaveCount(0);
  await expect.poll(async () => (await probeSnapshot(page)).lastBadge).toBe(baseline.lastBadge);
  await expect
    .poll(async () => {
      const probe = await probeSnapshot(page);
      return probe.closedTags.includes(notificationTag);
    })
    .toBe(true);
});

test("app badging counts topics with unread activity instead of raw activity volume", async ({ page, request }) => {
  await page.addInitScript(() => {
    const probe: AttentionProbe = {
      badgeCalls: [],
      notifications: [],
      closedTags: [],
      visibility: "visible",
    };
    window.__attentionProbe = probe;

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

    if ("serviceWorker" in navigator) {
      try {
        Object.defineProperty(navigator.serviceWorker, "ready", {
          configurable: true,
          get: () => Promise.resolve(null),
        });
      } catch {
        // Best-effort only. The notification fallback still works if this fails.
      }
    }

    class MockNotification {
      static permission: NotificationPermission = "granted";

      readonly tag: string;

      constructor(title: string, options?: NotificationOptions) {
        this.tag = String(options?.tag ?? "");
        probe.notifications.push({
          title,
          body: String(options?.body ?? ""),
          tag: this.tag,
        });
      }

      static async requestPermission() {
        return "granted" as const;
      }

      addEventListener() {}

      close() {
        if (this.tag) probe.closedTags.push(this.tag);
      }
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => window.__attentionProbe?.visibility ?? "visible",
    });

    window.localStorage.setItem("clawboard:push-enabled", "true");
  });

  const apiBase = process.env.PLAYWRIGHT_API_BASE ?? "http://127.0.0.1:3151";
  const suffix = Date.now();
  const firstTopic = {
    id: `topic-attention-count-a-${suffix}`,
    name: `Attention Count A ${suffix}`,
  };
  const secondTopic = {
    id: `topic-attention-count-b-${suffix}`,
    name: `Attention Count B ${suffix}`,
  };
  const topics = [firstTopic, secondTopic];

  for (const topic of topics) {
    const createTopic = await request.post(`${apiBase}/api/topics`, {
      data: { id: topic.id, name: topic.name, status: "active", pinned: false },
    });
    expect(createTopic.ok()).toBeTruthy();

    const initialLog = await request.post(`${apiBase}/api/log`, {
      data: {
        topicId: topic.id,
        type: "conversation",
        content: `Initial seen activity ${topic.id}`,
        summary: `Initial seen activity ${topic.id}`,
        classificationStatus: "classified",
        agentId: "assistant",
        agentLabel: "OpenClaw",
        source: { sessionKey: `clawboard:topic:${topic.id}` },
      },
    });
    expect(initialLog.ok()).toBeTruthy();
  }

  await page.goto("/u");
  await expect(page.getByRole("button", { name: /Shuffle Board Colors/i })).toBeVisible();
  await ensureBoardTopicsVisible(page);
  await expect.poll(async () => (await probeSnapshot(page)).badgeCallCount).toBeGreaterThan(0);

  const baseline = await probeSnapshot(page);

  await page.evaluate(() => {
    if (window.__attentionProbe) {
      window.__attentionProbe.visibility = "hidden";
    }
  });

  const appendUnreadLog = async (topicId: string, label: string) => {
    const response = await request.post(`${apiBase}/api/log`, {
      data: {
        topicId,
        type: "conversation",
        content: label,
        summary: label,
        classificationStatus: "classified",
        agentId: "assistant",
        agentLabel: "OpenClaw",
        source: { sessionKey: `clawboard:topic:${topicId}` },
      },
    });
    expect(response.ok()).toBeTruthy();
  };

  await appendUnreadLog(firstTopic.id, `Unread activity one ${suffix}`);
  await expect.poll(async () => (await probeSnapshot(page)).lastBadge).toBe(baseline.lastBadge + 1);

  await appendUnreadLog(firstTopic.id, `Unread activity two ${suffix}`);
  await expect.poll(async () => (await probeSnapshot(page)).lastBadge).toBe(baseline.lastBadge + 1);

  await appendUnreadLog(secondTopic.id, `Unread activity three ${suffix}`);
  await expect.poll(async () => (await probeSnapshot(page)).lastBadge).toBe(baseline.lastBadge + 2);

  const firstTopicNavRow = page.locator(`[data-board-topic-id="${firstTopic.id}"]`);
  const secondTopicNavRow = page.locator(`[data-board-topic-id="${secondTopic.id}"]`);
  const firstBadge = firstTopicNavRow.locator('[aria-label="1 topic needs a look"]');
  const secondBadge = secondTopicNavRow.locator('[aria-label="1 topic needs a look"]');

  await expect(firstBadge).toHaveCount(1);
  await expect(secondBadge).toHaveCount(1);
  await expect
    .poll(async () => {
      const probe = await probeSnapshot(page);
      return probe.notifications.some(
        (item) =>
          item.title === `Topic Activity: ${secondTopic.name}` ||
          (item.title === "ClawBoard" && /\btopics need a look\b/i.test(item.body))
      );
    })
    .toBe(true);
});
