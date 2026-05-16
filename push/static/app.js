// Page-side glue — Web Push variant.
//
// The page registers the SW, asks for notification permission, subscribes
// to push, and sends the subscription to the server. It then just renders
// the cached /prices.json whenever the SW signals an update.

const logEl = document.getElementById("log");
const pricesEl = document.getElementById("prices");
const generatedEl = document.getElementById("generated");
const statusEl = document.getElementById("push-status");

let lastPrices = {};

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, up) {
  statusEl.textContent = `push: ${text}`;
  statusEl.className = `status ${up ? "up" : "down"}`;
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function renderCachedPrices() {
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
      const prev = lastPrices[sym];
      let dir = "";
      let arrow = "";
      if (prev !== undefined && price !== prev) {
        dir = price > prev ? "up" : "down";
        arrow = price > prev ? "▲" : "▼";
      }
      const tr = document.createElement("tr");
      if (dir) tr.className = dir;
      tr.innerHTML =
        `<td>${sym}</td><td class="arrow">${arrow}</td>` +
        `<td class="price">${price}</td>`;
      pricesEl.appendChild(tr);
    }
    lastPrices = { ...data.prices };
    generatedEl.textContent = new Date(
      data.generatedAt * 1000
    ).toLocaleTimeString();
  } catch (err) {
    log("failed to read cache: " + err);
  }
}

async function main() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    setStatus("Push API unsupported in this browser", false);
    return;
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    const { type } = event.data || {};
    if (type === "price-update") {
      log("SW forwarded a push price-update; re-reading cached /prices.json");
      renderCachedPrices();
    } else if (type === "log") {
      log("SW: " + event.data.message);
    }
  });

  let reg;
  try {
    reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    log("service worker registered (scope " + reg.scope + ")");
  } catch (err) {
    setStatus("SW registration failed", false);
    log("SW registration failed: " + err);
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    setStatus("notification permission " + permission, false);
    log("notification permission not granted; push will not work");
    renderCachedPrices();
    return;
  }

  try {
    const key = await (await fetch("/vapidPublicKey")).text();
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }
    await fetch("/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    setStatus("subscribed", true);
    log("push subscription sent to server");
  } catch (err) {
    setStatus("subscribe failed", false);
    log("push subscribe failed: " + err);
  }

  renderCachedPrices();
}

main();
