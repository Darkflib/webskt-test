# WebSocket + Service Worker PoC

A learning proof of concept:

- A Python (aiohttp) server serves the static site, a `/prices.json`
  endpoint whose values change over time, and a `/ws` WebSocket that
  broadcasts a `price-update` every few seconds.
- A **service worker** owns the WebSocket connection. When it receives a
  `price-update` it fetches a fresh `/prices.json`, stores it in the
  Cache API, and notifies every open page from the site.
- Pages never open the socket themselves — they just render the cached
  `/prices.json` whenever the service worker tells them it changed.

```
server.py  -- aiohttp: static + /prices.json + /ws (one port)
static/
  index.html  -- UI, registers the SW
  app.js      -- registers SW, listens for SW messages, reads the cache
  sw.js       -- owns the WebSocket, refreshes + caches /prices.json
```

## Run locally

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python server.py            # http://localhost:8080
```

Open <http://localhost:8080>, watch the log panel, and check
DevTools → Application → Service Workers / Cache Storage.

Config via env vars: `PORT` (default 8080), `HOST` (default 0.0.0.0),
`TICK_SECONDS` (default 5).

## Deploying on a subdomain of mikepreston.org

Service workers and `wss://` require a **secure context**, so serve it
over HTTPS (a real cert, e.g. via your reverse proxy / Let's Encrypt).

Example nginx reverse proxy for `wsdemo.mikepreston.org`:

```nginx
server {
    listen 443 ssl;
    server_name wsdemo.mikepreston.org;

    # ssl_certificate / ssl_certificate_key ...

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;       # WebSocket upgrade
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

`localhost` is treated as a secure context too, so local testing works
over plain HTTP without a cert.

## Web Push variant

A second, connection-less implementation lives in [`push/`](push/). There
the server sends an encrypted Web Push on each price change, so updates
arrive **even with no tab open** (at the cost of requiring notification
permission). See [`push/README.md`](push/README.md) for the trade-off
table.

## Known limitation (by design, this is a PoC)

Service workers are **not long-lived**. Browsers terminate an idle SW
(often within ~30s), which closes any WebSocket it holds. Mitigations
used here:

- the SW reconnects with exponential backoff;
- open pages send a periodic `wake` message (and on tab focus) that
  restarts the SW so it can re-open the socket.

Net effect: delivery is reliable **while at least one tab is open**,
which is enough to demo the pattern. For genuine background push you
would use the **Push API + a push service**, not a WebSocket in a
service worker.
