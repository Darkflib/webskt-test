# Web Push variant (no WebSocket)

Same idea as the root WebSocket PoC, but the service worker holds **no
connection at all**. The server sends an encrypted, VAPID-signed Web Push
on every price change; the browser's push service delivers it and wakes
the service worker — **even with every tab closed**.

```
push/
  server.py            -- aiohttp: static + /prices.json + push endpoints
  static/index.html    -- UI + notification permission status
  static/app.js         -- registers SW, subscribes to push, renders cache
  static/sw.js          -- `push` handler: refresh+cache /prices.json, notify
  vapid_private.pem     -- auto-generated on first run (gitignored)
```

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r push/requirements.txt
cd push && PORT=8090 ../.venv/bin/python server.py   # http://localhost:8090
```

Open <http://localhost:8090>, **grant the notification prompt**, then
watch the log panel and your OS notifications. DevTools → Application →
Service Workers / Push lets you inspect and test-send pushes.

The VAPID key pair is generated once and saved to
`push/vapid_private.pem` so the `applicationServerKey` stays stable
across restarts (regenerating it would invalidate existing
subscriptions). Keep that file out of git (already in `.gitignore`).

Config via env: `PORT` (8090), `HOST`, `TICK_SECONDS` (5),
`VAPID_SUB` (contact mailto in the VAPID claim).

## Deploying on a subdomain of mikepreston.org

Same HTTPS requirement as the WebSocket version — the Push API only
works in a secure context. A plain reverse proxy is enough (no WebSocket
upgrade headers needed here):

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_set_header Host $host;
}
```

The **server** must be able to reach the browser vendor's push
endpoints outbound (e.g. `fcm.googleapis.com`,
`*.push.services.mozilla.com`). That's fine on a normal host; note that
a locked-down network policy could block it.

## Trade-offs vs. the WebSocket PoC

| | WebSocket PoC (root) | Web Push (this) |
|---|---|---|
| Background delivery (no tab open) | No — SW gets killed | **Yes** |
| Needs notification permission | No | Yes (Chrome forces a visible notification) |
| Latency | Instant while connected | Near-instant, via push service |
| Server complexity | Low | VAPID keys + encrypted push |
| Good for | live dashboards with a tab open | true background updates |

Chrome requires `userVisibleOnly: true`, so each push shows a system
notification — that's intentional here, not a bug.
