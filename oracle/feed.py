from avantis_trader_sdk import FeedClient
from datetime import datetime, timezone
import asyncio

PAIRS = ["ETH/USD", "BTC/USD", "SOL/USD"]
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

def extract_price(raw) -> float:
    """Safely extract a float price from whatever the SDK returns."""
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str):
        return float(raw)
    if isinstance(raw, dict):
        for key in ("price", "value", "current", "p"):
            if key in raw:
                return extract_price(raw[key])
        for v in raw.values():
            if isinstance(v, (int, float, str)):
                try:
                    return float(v)
                except (ValueError, TypeError):
                    continue
    for attr in ("price", "value", "current"):
        if hasattr(raw, attr):
            return extract_price(getattr(raw, attr))
    raise ValueError(f"Cannot extract price from: {type(raw)} = {raw}")

def make_handler(pair: str):
    def handler(data):
        global _last_update_ms, _connected
        try:
            price = extract_price(data.price)
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
            print(f"[Oracle] Handler error for {pair}: {e} | raw type: {type(data.price)} val: {data.price}")
    return handler

def ws_error_handler(e):
    global _connected
    _connected = False
    print(f"[Oracle] WebSocket error: {e}")

def ws_close_handler(e):
    global _connected
    _connected = False
    print(f"[Oracle] WebSocket closed: {e}")

async def start_feed():
    global _connected
    while True:
        try:
            print("[Oracle] Connecting to Pyth price feed...")
            client = FeedClient(
                on_error=ws_error_handler,
                on_close=ws_close_handler,
            )
            for pair in PAIRS:
                client.register_price_feed_callback(pair, make_handler(pair))
            print(f"[Oracle] Subscribed to: {', '.join(PAIRS)}")
            await client.listen_for_price_updates()
        except Exception as e:
            _connected = False
            print(f"[Oracle] Feed error: {e}. Reconnecting in 3s...")
            await asyncio.sleep(3)
