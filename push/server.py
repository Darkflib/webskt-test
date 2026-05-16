"""PoC: Web Push variant (no WebSocket).

Compared to the WebSocket PoC, the service worker here holds NO long-lived
connection. Instead the browser's push service delivers messages, so
updates arrive even when no tab is open (subject to the user granting
notification permission). Flow:

  GET  /                -> static/index.html
  GET  /sw.js           -> service worker (root scope)
  GET  /static/*        -> static assets
  GET  /prices.json     -> current prices (changes over time)
  GET  /vapidPublicKey  -> VAPID application server key (base64url)
  POST /subscribe       -> store a PushSubscription
  POST /unsubscribe     -> drop a PushSubscription

A background ticker mutates prices every TICK_SECONDS and sends an
encrypted Web Push (VAPID-signed) to every stored subscription.
"""

import asyncio
import base64
import json
import os
import random
import time
from pathlib import Path

from aiohttp import web
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid01
from pywebpush import WebPushException, webpush

HERE = Path(__file__).parent
STATIC = HERE / "static"
KEY_PATH = HERE / "vapid_private.pem"

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8090"))
TICK_SECONDS = float(os.environ.get("TICK_SECONDS", "5"))
# Push services require a contact in the VAPID "sub" claim.
VAPID_SUB = os.environ.get("VAPID_SUB", "mailto:admin@example.com")

SYMBOLS = ["AAPL", "GOOG", "BTC", "ETH", "GME"]


def make_initial_prices():
    return {s: round(random.uniform(50, 500), 2) for s in SYMBOLS}


def jitter(prices):
    for s in prices:
        delta = prices[s] * random.uniform(-0.02, 0.02)
        prices[s] = round(max(1.0, prices[s] + delta), 2)
    return prices


def load_or_create_vapid():
    """Persist the VAPID key so the applicationServerKey stays stable
    across restarts (otherwise existing subscriptions break)."""
    if KEY_PATH.exists():
        v = Vapid01.from_file(str(KEY_PATH))
    else:
        v = Vapid01()
        v.generate_keys()
        v.save_key(str(KEY_PATH))
    raw = v.public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    app_server_key = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
    return app_server_key


async def index(request):
    return web.FileResponse(STATIC / "index.html")


async def service_worker(request):
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
        {"generatedAt": time.time(), "prices": request.app["prices"]}
    )
    return web.Response(
        body=body,
        content_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


async def vapid_public_key(request):
    return web.Response(
        text=request.app["app_server_key"],
        headers={"Cache-Control": "no-store"},
    )


async def subscribe(request):
    sub = await request.json()
    if not sub.get("endpoint"):
        return web.json_response({"error": "missing endpoint"}, status=400)
    request.app["subs"][sub["endpoint"]] = sub
    request.app.logger.info(
        "subscribed (total=%d)", len(request.app["subs"])
    )
    return web.json_response({"ok": True})


async def unsubscribe(request):
    sub = await request.json()
    request.app["subs"].pop(sub.get("endpoint", ""), None)
    return web.json_response({"ok": True})


def _send_one(sub, payload):
    """Blocking pywebpush call; run in an executor."""
    webpush(
        subscription_info=sub,
        data=payload,
        vapid_private_key=str(KEY_PATH),
        vapid_claims={"sub": VAPID_SUB},
        timeout=10,
    )


async def push_to_all(app, payload):
    loop = asyncio.get_running_loop()
    for endpoint, sub in list(app["subs"].items()):
        try:
            await loop.run_in_executor(None, _send_one, sub, payload)
        except WebPushException as exc:
            status = getattr(exc.response, "status_code", None)
            if status in (404, 410):
                # Subscription is dead; stop pushing to it.
                app["subs"].pop(endpoint, None)
                app.logger.info("dropped stale subscription %s", status)
            else:
                app.logger.warning("push failed (%s): %s", status, exc)
        except Exception as exc:  # network/DNS to push service, etc.
            app.logger.warning("push error: %s", exc)


async def price_ticker(app):
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
            await push_to_all(app, payload)
    except asyncio.CancelledError:
        pass


async def on_startup(app):
    app["prices"] = make_initial_prices()
    app["subs"] = {}
    app["app_server_key"] = load_or_create_vapid()
    app["ticker"] = asyncio.create_task(price_ticker(app))


async def on_cleanup(app):
    app["ticker"].cancel()
    await app["ticker"]


def make_app():
    app = web.Application()
    app.add_routes(
        [
            web.get("/", index),
            web.get("/sw.js", service_worker),
            web.get("/prices.json", prices_json),
            web.get("/vapidPublicKey", vapid_public_key),
            web.post("/subscribe", subscribe),
            web.post("/unsubscribe", unsubscribe),
            web.static("/static", STATIC),
        ]
    )
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=HOST, port=PORT)
