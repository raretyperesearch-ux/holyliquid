from avantis_trader_sdk import FeedClient
from datetime import datetime, timezone
import asyncio

PAIRS = ["ETH/USD", "BTC/USD", "SOL/USD"]

# Force a reconnect if no price update arrives within this many ms. Set well
# above the consumer's freshness limit so transient hiccups don't churn the
# socket, but low enough that a silently-dead feed recovers in well under a
# minute.
WATCHDOG_STALE_MS = 15_000
WATCHDOG_CHECK_INTERVAL_S = 2.0
WATCHDOG_GRACE_S = 10.0

cache: dict = {}
_last_update_ms: int = 0
_connected: bool = False

def get_price(pair: str):
    return cache.get(pair)

def get_all_prices():
    return cache

def get_oracle_status():
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    age_ms = now_ms - _last_update_ms if _last_update_ms else None
    stale = age_ms is None or age_ms > 5000
    return {
        "ok": _connected and not stale,
        "connected": _connected,
        "pairs": list(cache.keys()),
        "last_update_ms": _last_update_ms or None,
        "age_ms": age_ms,
        "stale": stale,
    }

def extract_price(data) -> float:
    """
    Extract human-readable price from Pyth/Avantis callback data.
    Pyth stores prices as: { price: str, conf: str, expo: int, publish_time: int }
    Real price = float(price) * 10^expo  (expo is typically -8)
    """
    raw = data.price

    # Case 1: dict with Pyth format { price, expo }
    if isinstance(raw, dict):
        if 'price' in raw and 'expo' in raw:
            return float(raw['price']) * (10 ** int(raw['expo']))
        # dict but different structure — try first numeric value
        for v in raw.values():
            try:
                return float(v)
            except (ValueError, TypeError):
                continue

    # Case 2: object with .price and .expo attributes (Pyth Price object)
    if hasattr(raw, 'price') and hasattr(raw, 'expo'):
        return float(raw.price) * (10 ** int(raw.expo))

    # Case 3: already a plain number
    if isinstance(raw, (int, float)):
        return float(raw)

    if isinstance(raw, str):
        return float(raw)

    # Case 4: object with just .price attribute
    if hasattr(raw, 'price'):
        return extract_price_from_value(raw.price)

    raise ValueError(f"Cannot extract price from: {type(raw)} = {raw}")

def extract_price_from_value(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        return float(v)
    raise ValueError(f"Cannot convert to float: {type(v)} = {v}")

def make_handler(pair: str):
    def handler(data):
        global _last_update_ms, _connected
        try:
            price = extract_price(data)
            now = datetime.now(timezone.utc)
            cache[pair] = {
                "pair":      pair,
                "price":     price,
                "timestamp": now.isoformat(),
                "ts_ms":     int(now.timestamp() * 1000),
            }
            _last_update_ms = int(now.timestamp() * 1000)
            _connected = True
            print(f"[Oracle] {pair}: ${price:.4f}")
        except Exception as e:
            # Log the raw structure so we can debug further if needed
            print(f"[Oracle] Handler error for {pair}: {e}")
            try:
                print(f"[Oracle] data.price type={type(data.price)} val={data.price}")
            except:
                print(f"[Oracle] data type={type(data)}")
    return handler

def ws_error_handler(e):
    global _connected
    _connected = False
    print(f"[Oracle] WebSocket error: {e}")

def ws_close_handler(e):
    global _connected
    _connected = False
    print(f"[Oracle] WebSocket closed: {e}")

async def _staleness_watchdog():
    """Return once price updates have gone stale, so the caller can reconnect.

    The Avantis FeedClient's `on_close` / `on_error` callbacks just set a flag —
    they don't actually break out of `listen_for_price_updates()`. If the
    websocket silently dies (no exception, no close frame), the listen task
    blocks forever and prices stay frozen. This watchdog races the listen task
    so we can force a reconnect when the handler stops firing.
    """
    # Give the feed a chance to deliver the first updates before we start
    # measuring staleness — otherwise we'd reconnect immediately on startup.
    await asyncio.sleep(WATCHDOG_GRACE_S)
    while True:
        await asyncio.sleep(WATCHDOG_CHECK_INTERVAL_S)
        if _last_update_ms == 0:
            # Nothing has ever arrived; treat the grace period as our deadline.
            print("[Oracle] Watchdog: no price updates since startup — reconnecting")
            return
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        age_ms = now_ms - _last_update_ms
        if age_ms > WATCHDOG_STALE_MS:
            print(f"[Oracle] Watchdog: no price updates for {age_ms}ms — reconnecting")
            return


async def _cancel_and_wait(task: asyncio.Task):
    if task.done():
        return
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass


async def start_feed():
    global _connected, _last_update_ms
    while True:
        listen_task = None
        watchdog_task = None
        try:
            print("[Oracle] Connecting to Pyth price feed...")
            client = FeedClient(
                on_error=ws_error_handler,
                on_close=ws_close_handler,
            )
            for pair in PAIRS:
                client.register_price_feed_callback(pair, make_handler(pair))
            print(f"[Oracle] Subscribed to: {', '.join(PAIRS)}")

            # Reset the staleness clock for this connection attempt so the
            # watchdog measures freshness relative to the new socket.
            _last_update_ms = 0

            listen_task = asyncio.create_task(client.listen_for_price_updates())
            watchdog_task = asyncio.create_task(_staleness_watchdog())

            done, _pending = await asyncio.wait(
                {listen_task, watchdog_task},
                return_when=asyncio.FIRST_COMPLETED,
            )

            # Surface any exception from whichever task finished first.
            for t in done:
                if t.cancelled():
                    continue
                exc = t.exception()
                if exc is not None:
                    print(f"[Oracle] Feed task ended with error: {exc}")
        except Exception as e:
            print(f"[Oracle] Feed error: {e}")
        finally:
            _connected = False
            if listen_task is not None:
                await _cancel_and_wait(listen_task)
            if watchdog_task is not None:
                await _cancel_and_wait(watchdog_task)
            print("[Oracle] Reconnecting in 3s...")
            await asyncio.sleep(3)
