import { PriceData } from './types'

const ORACLE_URL = process.env.ORACLE_SERVICE_URL || 'http://localhost:8000'
const PRICE_FRESHNESS_MS = 3000
const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1000

let _lastTickMs = 0

export function getLastOracleTick(): number {
  return _lastTickMs
}

export async function connectOracle(): Promise<void> {
  // Verify oracle is reachable and has live prices
  let attempts = 0
  while (attempts < 10) {
    try {
      const res = await fetch(`${ORACLE_URL}/prices`)
      if (res.ok) {
        const data = await res.json() as Record<string, any>
        if (Object.keys(data).length === 3) {
          _lastTickMs = Date.now()
          return
        }
      }
    } catch {}
    attempts++
    console.log(`[Oracle] Waiting for prices... (attempt ${attempts}/10)`)
    await sleep(2000)
  }
  throw new Error('[Oracle] Could not connect after 10 attempts. Is the oracle service running?')
}

export async function fetchFreshPrice(pair: string): Promise<PriceData | null> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const res = await fetch(`${ORACLE_URL}/price/${encodeURIComponent(pair)}`)
      if (!res.ok) {
        if (i < MAX_RETRIES - 1) await sleep(RETRY_DELAY_MS)
        continue
      }
      const data = await res.json() as any
      const ageMs = Date.now() - data.ts_ms
      if (ageMs < PRICE_FRESHNESS_MS) {
        _lastTickMs = Date.now()
        return {
          pair:      data.pair,
          price:     data.price,
          timestamp: data.ts_ms,
        }
      }
      console.warn(`[Oracle] Price stale for ${pair}: ${ageMs}ms old`)
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
