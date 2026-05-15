// Service worker that owns the WebSocket connection.
//
// IMPORTANT CAVEAT (this is a PoC / learning exercise):
// Service workers are NOT long-lived. The browser may terminate an idle
// SW within ~30s, which kills any WebSocket it holds. There is no API to
// keep a SW alive indefinitely. The mitigation here is:
//   - aggressive reconnect with backoff, and
//   - open pages periodically post a "wake" message (see app.js), which
//     restarts the SW and lets it re-open the WebSocket.
// So the connection is reliable *while at least one tab is open*, which is
// enough to demo the pattern. For true background delivery you'd use the
// Push API instead.

const CACHE_NAME = "prices-cache-v1";
const PRICES_URL = "/prices.json";

let socket = null;
let reconnectDelay = 1000;
let connecting = false;

function wsUrl() {
  const proto = self.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${self.location.host}/ws`;
}

async function broadcast(message) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clients) client.postMessage(message);
}

async function refreshPricesCache() {
  try {
    // Bypass the HTTP cache; we want the freshly generated server copy.
    const res = await fetch(PRICES_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(PRICES_URL, res.clone());
    await broadcast({ type: "log", message: "cached fresh /prices.json" });
  } catch (err) {
    await broadcast({ type: "log", message: "prices fetch failed: " + err });
  }
}

function connect() {
  if (connecting || (socket && socket.readyState === WebSocket.OPEN)) return;
  connecting = true;

  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    connecting = false;
    scheduleReconnect();
    return;
  }

  socket.addEventListener("open", () => {
    connecting = false;
    reconnectDelay = 1000;
    broadcast({ type: "ws-status", connected: true });
  });

  socket.addEventListener("message", async (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return; // ignore non-JSON (e.g. "pong")
    }
    if (data.type === "price-update") {
      // The reason this PoC exists: on price-update, pull a fresh
      // /prices.json and cache it for offline/local use, then tell pages.
      await refreshPricesCache();
      await broadcast({ type: "price-update", generatedAt: data.generatedAt });
    } else if (data.type === "snapshot") {
      await refreshPricesCache();
      await broadcast({ type: "price-update", generatedAt: data.generatedAt });
    }
  });

  socket.addEventListener("close", () => {
    connecting = false;
    broadcast({ type: "ws-status", connected: false });
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {}
  });
}

function scheduleReconnect() {
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 30000);
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim().then(connect));
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "wake") {
    connect();
  }
});

// If the SW is started by any fetch event, take the opportunity to ensure
// the socket is up.
self.addEventListener("fetch", (event) => {
  connect();
});
