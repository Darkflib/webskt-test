"""PoC WebSocket + static server.

Single aiohttp app on one port so it sits cleanly behind a reverse proxy
on a subdomain:

  GET  /            -> static/index.html
  GET  /static/*    -> static assets (app.js, sw.js, ...)
  GET  /sw.js       -> service worker, served from the root scope on purpose
  GET  /prices.json -> current prices (changes over time)
  GET  /ws          -> WebSocket; broadcasts a "price-update" every tick
"""

import asyncio
import json
import os
import random
import time
from pathlib import Path

from aiohttp import WSMsgType, web

HERE = Path(__file__).parent
STATIC = HERE / "static"

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8080"))
TICK_SECONDS = float(os.environ.get("TICK_SECONDS", "5"))

SYMBOLS = ["AAPL", "GOOG", "BTC", "ETH", "GME"]


def make_initial_prices():
    return {s: round(random.uniform(50, 500), 2) for s in SYMBOLS}


def jitter(prices):
    """Nudge every price by a small random walk so changes are visible."""
    for s in prices:
        delta = prices[s] * random.uniform(-0.02, 0.02)
        prices[s] = round(max(1.0, prices[s] + delta), 2)
    return prices


async def index(request):
    return web.FileResponse(STATIC / "index.html")


async def service_worker(request):
    # Served from "/" so its scope can control the whole origin.
    return web.FileResponse(
        STATIC / "sw.js",
        headers={
            "Content-Type": "application/javascript",
            "Cache-Control": "no-cache",
            "Service-Worker-Allowed": "/",
        },
    )


async def prices_json(request):
    body = json.dumps(
        {
            "generatedAt": time.time(),
            "prices": request.app["prices"],
        }
    )
    return web.Response(
        body=body,
        content_type="application/json",
        # Let the service worker's Cache API be the source of truth, not the
        # HTTP cache, so the PoC behaviour is easy to observe.
        headers={"Cache-Control": "no-store"},
    )


async def websocket_handler(request):
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    clients = request.app["ws_clients"]
    clients.add(ws)
    request.app.logger.info("ws client connected (total=%d)", len(clients))

    # Send a snapshot immediately so a fresh client isn't blank until the
    # next tick.
    await ws.send_json(
        {"type": "snapshot", "generatedAt": time.time(), "prices": request.app["prices"]}
    )

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT and msg.data == "ping":
                await ws.send_str("pong")
            elif msg.type == WSMsgType.ERROR:
                request.app.logger.warning("ws error: %s", ws.exception())
    finally:
        clients.discard(ws)
        request.app.logger.info("ws client disconnected (total=%d)", len(clients))

    return ws


async def price_ticker(app):
    """Background task: mutate prices and broadcast a price-update."""
    try:
        while True:
            await asyncio.sleep(TICK_SECONDS)
            app["prices"] = jitter(dict(app["prices"]))
            payload = json.dumps(
                {
                    "type": "price-update",
                    "generatedAt": time.time(),
                    "prices": app["prices"],
                }
            )
            dead = []
            for ws in app["ws_clients"]:
                try:
                    await ws.send_str(payload)
                except ConnectionResetError:
                    dead.append(ws)
            for ws in dead:
                app["ws_clients"].discard(ws)
    except asyncio.CancelledError:
        pass


async def on_startup(app):
    app["prices"] = make_initial_prices()
    app["ws_clients"] = set()
    app["ticker"] = asyncio.create_task(price_ticker(app))


async def on_cleanup(app):
    app["ticker"].cancel()
    await app["ticker"]
    for ws in list(app["ws_clients"]):
        await ws.close()


def make_app():
    app = web.Application()
    app.add_routes(
        [
            web.get("/", index),
            web.get("/sw.js", service_worker),
            web.get("/prices.json", prices_json),
            web.get("/ws", websocket_handler),
            web.static("/static", STATIC),
        ]
    )
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=HOST, port=PORT)
