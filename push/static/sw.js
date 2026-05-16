// Service worker — Web Push variant.
//
// No WebSocket here. The browser's push service wakes this SW with a
// `push` event even when no page is open. On a price-update we refresh
// and cache /prices.json, notify any open pages, and (required by Chrome
// for userVisibleOnly subscriptions) show a notification.

const CACHE_NAME = "prices-cache-v1";
const PRICES_URL = "/prices.json";

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function refreshPricesCache() {
  try {
    const res = await fetch(PRICES_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(PRICES_URL, res.clone());
    return res.json();
  } catch (err) {
    await broadcast({ type: "log", message: "prices fetch failed: " + err });
    return null;
  }
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  event.waitUntil(
    (async () => {
      if (data.type !== "price-update") return;

      const fresh = await refreshPricesCache();
      await broadcast({ type: "price-update", generatedAt: data.generatedAt });

      // Chrome requires a user-visible notification for each push when
      // subscribed with userVisibleOnly:true.
      let body = "Prices updated";
      if (fresh && fresh.prices) {
        body = Object.entries(fresh.prices)
          .map(([s, p]) => `${s} ${p}`)
          .join("  ");
      }
      await self.registration.showNotification("Price update", {
        body,
        tag: "price-update", // collapse repeated notifications
        renotify: false,
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const c of clients) {
          if ("focus" in c) return c.focus();
        }
        return self.clients.openWindow("/");
      })
  );
});
