const CACHE_VERSION = "v1";
const STATIC_CACHE = `static-${CACHE_VERSION}`;
const RUNTIME_CACHE = `runtime-${CACHE_VERSION}`;
const NOTIFICATION_CLICK_MESSAGE_TYPE = "clawboard:notification-clicked";
const NOTIFY_TOPIC_PARAM = "cbn_topic";
const NOTIFY_TASK_PARAM = "cbn_task";
const NOTIFY_CHAT_PARAM = "cbn_chat";
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];

function normalizeNotificationData(input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  const url = typeof input.url === "string" ? input.url.trim() : "";
  const topicId = typeof input.topicId === "string" ? input.topicId.trim() : "";
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  const chatKey = typeof input.chatKey === "string" ? input.chatKey.trim() : "";
  if (url) out.url = url;
  if (topicId) out.topicId = topicId;
  if (taskId) out.taskId = taskId;
  if (chatKey) out.chatKey = chatKey;
  return out;
}

function withNotificationParams(targetUrl, data) {
  let parsed;
  try {
    parsed = new URL(targetUrl, self.location.origin);
  } catch {
    return targetUrl;
  }

  if (data.topicId) parsed.searchParams.set(NOTIFY_TOPIC_PARAM, data.topicId);
  if (data.taskId) parsed.searchParams.set(NOTIFY_TASK_PARAM, data.taskId);
  if (data.chatKey) parsed.searchParams.set(NOTIFY_CHAT_PARAM, data.chatKey);

  if (parsed.origin === self.location.origin) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification?.close();
  const notificationData = normalizeNotificationData(event.notification?.data);
  const requested = typeof notificationData.url === "string" && notificationData.url.trim() ? notificationData.url.trim() : "/";
  const targetUrl = withNotificationParams(requested, notificationData);
  const message = { type: NOTIFICATION_CLICK_MESSAGE_TYPE, data: notificationData };

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        let sameOrigin = false;
        try {
          sameOrigin = new URL(client.url).origin === self.location.origin;
        } catch {
          sameOrigin = false;
        }
        if (!sameOrigin) continue;
        try {
          if (typeof client.navigate === "function") {
            await client.navigate(targetUrl);
          }
        } catch {
          // ignore navigation failures and still try to focus
        }
        if (typeof client.postMessage === "function") {
          client.postMessage(message);
        }
        if (typeof client.focus === "function") {
          await client.focus();
        }
        return;
      }
      if (self.clients.openWindow) {
        const openedClient = await self.clients.openWindow(targetUrl);
        if (openedClient && typeof openedClient.postMessage === "function") {
          openedClient.postMessage(message);
        }
      }
    })()
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw error;
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) {
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
      })
      .catch(() => {});
    return cached;
  }
  const response = await fetch(request);
  if (response && response.status === 200) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      networkFirst(request, RUNTIME_CACHE).catch(() => caches.match("/"))
    );
    return;
  }

  if (
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".jpeg") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".avif") ||
    url.pathname.endsWith(".gif") ||
    url.pathname.endsWith(".ico") ||
    url.pathname.endsWith(".css") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".woff2") ||
    url.pathname.endsWith(".woff") ||
    url.pathname.endsWith(".ttf")
  ) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE));
});
