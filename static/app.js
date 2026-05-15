// Page-side glue.
//
// The page deliberately does NOT open the WebSocket itself. The service
// worker owns the connection; the page just:
//   1. registers the SW,
//   2. listens for messages the SW forwards,
//   3. re-reads the cached /prices.json (which the SW keeps fresh).

const logEl = document.getElementById("log");
const pricesEl = document.getElementById("prices");
const generatedEl = document.getElementById("generated");
const swStatusEl = document.getElementById("sw-status");

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setSwStatus(text, up) {
  swStatusEl.textContent = `service worker: ${text}`;
  swStatusEl.className = `status ${up ? "up" : "down"}`;
}

async function renderCachedPrices() {
  // Read the copy the service worker stored in the Cache API.
  try {
    const cache = await caches.open("prices-cache-v1");
    const res = await cache.match("/prices.json");
    if (!res) {
      log("no cached /prices.json yet");
      return;
    }
    const data = await res.json();
    pricesEl.innerHTML = "";
    for (const [sym, price] of Object.entries(data.prices)) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${sym}</td><td class="price">${price}</td>`;
      pricesEl.appendChild(tr);
    }
    generatedEl.textContent = new Date(
      data.generatedAt * 1000
    ).toLocaleTimeString();
  } catch (err) {
    log("failed to read cache: " + err);
  }
}

async function main() {
  if (!("serviceWorker" in navigator)) {
    setSwStatus("unsupported in this browser", false);
    return;
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    const { type } = event.data || {};
    if (type === "ws-status") {
      setSwStatus(event.data.connected ? "WS connected" : "WS disconnected",
        event.data.connected);
      log(`SW says WebSocket ${event.data.connected ? "connected" : "down"}`);
    } else if (type === "price-update") {
      log("SW forwarded a price-update; re-reading cached /prices.json");
      renderCachedPrices();
    } else if (type === "log") {
      log("SW: " + event.data.message);
    }
  });

  try {
    const reg = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    log("service worker registered (scope " + reg.scope + ")");
  } catch (err) {
    setSwStatus("registration failed", false);
    log("SW registration failed: " + err);
    return;
  }

  await navigator.serviceWorker.ready;
  setSwStatus("registered", true);

  // Nudge the SW now, and whenever the tab becomes visible again, to
  // (re)establish the WebSocket. Service workers can be killed when idle,
  // so this is the PoC's keep-alive strategy.
  function wake() {
    navigator.serviceWorker.controller?.postMessage({ type: "wake" });
  }
  wake();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  setInterval(wake, 20000);

  renderCachedPrices();
}

main();
