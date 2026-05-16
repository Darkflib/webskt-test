# WebSocket vs. Web Push — implementation comparison

This repo contains two solutions to the same problem:

> *Keep a site's pages showing fresh prices by having a service worker
> refresh and cache `/prices.json` whenever the server says prices
> changed.*

- **WebSocket PoC** — root (`server.py`, `static/`)
- **Web Push PoC** — `push/` (`push/server.py`, `push/static/`)

Both end with the **identical client behaviour**: the service worker
fetches `/prices.json`, stores it in the Cache API, and `postMessage`s
open pages, which re-render from the cache. Only the *transport that
tells the service worker "prices changed"* differs — and that one
difference cascades into very different lifecycle, security, and
operational properties.

---

## 1. The shared part

```
                 (this part is the same in both)
  server mutates prices  ──▶  service worker  ──fetch──▶  /prices.json
                                    │                         │
                                    ▼                          ▼
                              Cache API (prices-cache-v1)   page renders
                                    │                       from cache
                                    └────postMessage────▶  open page(s)
```

Caching in the service worker (not the page) means the freshest copy is
shared by every tab and survives reloads, and the page logic stays
trivial: "read cache, render".

## 2. The difference in one sentence

- **WebSocket:** the *application* owns a persistent TCP connection that
  the service worker opens and must keep alive.
- **Web Push:** the *browser vendor* owns the delivery channel; the
  server hands a message to that channel and the browser wakes the
  service worker — no connection on our side.

---

## 3. WebSocket implementation

### How it works

```
page ──register──▶ service worker ──ws://…/ws──▶ aiohttp server
                         ▲   │                       │ broadcasts
                         │   └── on price-update ────┘ every tick
                         └── postMessage ──▶ page
```

The service worker calls `new WebSocket(...)`, listens for `message`
events, and on `price-update` refreshes the cache and notifies pages.
The server keeps a set of connected sockets and `send`s to all of them
on each tick.

### The lifecycle problem (the central caveat)

A service worker is **event-driven and disposable**. The browser starts
it to handle an event and may terminate it seconds later when idle.
There is **no API to keep a service worker alive**. A WebSocket lives
inside that worker, so when the worker is killed, the socket dies with
it.

Mitigations used in the PoC:

- **Reconnect with exponential backoff** when the socket closes.
- **Page-driven keep-alive:** open pages `postMessage` a `wake` every
  20s and on tab focus, which restarts the worker so it can re-open the
  socket; any `fetch` also nudges it.

Net result: reliable **only while at least one tab is open**. True
background delivery is impossible with this design — that's not a bug to
fix, it's a property of the platform.

### Properties

- No extra permissions, no notification.
- Lowest server complexity: a socket set and a broadcast loop.
- Sub-millisecond latency while connected.
- One long-lived TCP connection per client → matters at scale
  (file-descriptor / memory pressure on the server, idle-timeout tuning
  on any proxy in front).

---

## 4. Web Push implementation

### How it works

```
                ┌──────────────────── browser vendor ───────────────────┐
page ─subscribe─┤  push service (FCM / Mozilla autopush / WNS)           │
   │            └───────────────▲───────────────────┬───────────────────┘
   │ POST subscription          │ encrypted POST     │ delivers + wakes SW
   ▼                            │ (VAPID-signed)     ▼
server stores subscription ─────┘            service worker `push` event
                                                     │ refresh + cache
                                                     ▼ showNotification
```

1. The page asks for **notification permission**, then
   `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.
2. The browser returns a **subscription**: a vendor-specific `endpoint`
   URL plus client public keys (`p256dh`, `auth`).
3. The page POSTs that subscription to our server, which stores it.
4. On each price change the server sends an HTTP POST to the endpoint —
   the body **encrypted** for that subscription and the request
   **signed** with VAPID.
5. The vendor's push service delivers it and **wakes the service
   worker's `push` event even with no tab open**.

### Key technologies

- **VAPID (RFC 8292)** — "Voluntary Application Server Identification".
  An ECDSA P-256 key pair owned by *our server*. The public key is the
  `applicationServerKey` the browser subscribes with; every push is
  signed with the private key so the push service can attribute and
  rate-limit traffic to us. The PoC generates this once and persists it
  (`push/vapid_private.pem`) — regenerating it would invalidate every
  existing subscription.
- **Message Encryption (RFC 8291)** — payloads are encrypted with a key
  derived from the subscription's `p256dh`/`auth` material, so the push
  service relays ciphertext it cannot read. `pywebpush` does this for
  us.
- **`userVisibleOnly: true`** — Chrome requires that *each* push results
  in a user-visible notification; that's why the service worker calls
  `showNotification`. It's a platform rule, not an optional extra.

### Properties

- **Works with every tab closed** — the defining advantage.
- Requires the user to **grant notification permission**, and shows a
  notification per push.
- Higher server complexity: VAPID key management, per-subscription
  encryption, subscription storage, and pruning dead subscriptions
  (HTTP `404`/`410` from the endpoint).
- The **server needs outbound HTTPS** to vendor push endpoints
  (`fcm.googleapis.com`, `*.push.services.mozilla.com`, …). A
  locked-down egress policy breaks delivery — unlike WebSocket, where
  the client dials out.
- No long-lived connections held by our server → scales differently:
  state is a subscription list, work is N outbound POSTs per tick.

---

## 5. Side-by-side

| Aspect | WebSocket (root) | Web Push (`push/`) |
|---|---|---|
| Background delivery (no tab) | ❌ impossible | ✅ yes |
| Connection owner | our app, inside the SW | browser vendor's push service |
| Survives SW termination | ❌ socket dies with the worker | ✅ push restarts the worker |
| User permission | none | notification permission required |
| User-visible side effect | none | a notification per push (Chrome) |
| Secure context (HTTPS) | required (`wss://`) | required (Push API) |
| Server-side crypto | none | VAPID signing + payload encryption |
| Server state | open sockets | stored subscriptions |
| Network direction | client dials out to us | we POST out to vendor |
| Latency | instant while connected | near-instant via push service |
| Failure mode | disconnect → reconnect loop | stale subs → prune on 404/410 |
| Server complexity | low | moderate |

## 6. Which to use

- **Live dashboard / trading screen with a tab open, lowest latency,
  no permission friction** → WebSocket. Accept that it only works while
  the page is open.
- **Genuine background updates** (notify even when the site isn't open,
  re-engagement, "price alert" semantics) → Web Push. Accept the
  permission prompt, the mandatory notification, and the extra server
  machinery.
- **Both at once** is a common production pattern: a WebSocket for
  low-latency updates while the user is active, plus Web Push so
  something still reaches them when they've closed the tab.

## 7. What neither changes

The `/prices.json` + Cache API + `postMessage` pattern is transport
agnostic. If you swapped in Server-Sent Events, long-polling, or a
WebTransport stream, only the "how the SW learns prices changed" box
would change — the caching and page-render half stays exactly as it is
in both implementations here.
