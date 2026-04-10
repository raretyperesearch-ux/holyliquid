import { PriceData } from './types'

const ORACLE_URL = process.env.ORACLE_SERVICE_URL || 'http://localhost:8000'
const PRICE_FRESHNESS_MS = 5000  // bumped to 5s to account for network latency
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

let _lastTickMs = 0

export function getLastOracleTick(): number {
  return _lastTickMs
}

export async function connectOracle(): Promise<void> {
  let attempts = 0
  while (attempts < 15) {
    try {
      const prices = await getAllPrices()
      if (prices && Object.keys(prices).length >= 3) {
        _lastTickMs = Date.now()
        return
      }
    } catch {}
    attempts++
    console.log(`[Oracle] Waiting for prices... (attempt ${attempts}/15)`)
    await sleep(2000)
  }
  throw new Error('[Oracle] Could not connect after 15 attempts')
}

async function getAllPrices(): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(`${ORACLE_URL}/prices`)
    if (!res.ok) return null
    return await res.json() as Record<string, any>
  } catch {
    return null
  }
}

export async function fetchFreshPrice(pair: string): Promise<PriceData | null> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      // Fetch all prices at once — avoids the ETH/USD slash-in-URL routing bug
      const all = await getAllPrices()
      if (!all || !all[pair]) {
        if (i < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS)
        continue
      }

      const data = all[pair]
      const ageMs = Date.now() - data.ts_ms

      if (ageMs < PRICE_FRESHNESS_MS) {
        _lastTickMs = Date.now()
        return {
          pair:      data.pair,
          price:     data.price,
          timestamp: data.ts_ms,
        }
      }

      console.warn(`[Oracle] Price stale for ${pair}: ${ageMs}ms old (limit: ${PRICE_FRESHNESS_MS}ms)`)
    } catch (e) {
      console.warn(`[Oracle] Fetch error for ${pair}:`, e)
    }
    if (i < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS)
  }
  return null
}

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}
