from fastapi import FastAPI, HTTPException
from feed import start_feed, get_price, get_all_prices, get_oracle_status
from dotenv import load_dotenv
import asyncio

load_dotenv()

app = FastAPI(title="HolyLiquid Oracle")

@app.on_event("startup")
async def startup():
    asyncio.create_task(start_feed())

@app.get("/prices")
async def prices():
    p = get_all_prices()
    if not p:
        raise HTTPException(status_code=503, detail="No prices available yet")
    return p

@app.get("/price/{pair}")
async def price(pair: str):
    p = get_price(pair)
    if not p:
        raise HTTPException(status_code=503, detail=f"Price unavailable for {pair}")
    return p

@app.get("/health")
async def health():
    status = get_oracle_status()
    return status
