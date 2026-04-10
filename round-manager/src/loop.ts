import { db } from './db'
import { fetchFreshPrice } from './oracle'
import { generatePosition, calcLiqPrice, generateSeed } from './position'
import { calculateResult, settleRound } from './settle'
import { voidRound } from './void'
import { broadcast } from './broadcast'

const ROUND_DURATION_MS   = 30_000
const BETTING_DURATION_MS = 10_000
const TICK_INTERVAL_MS    = 1_000

export async function gameLoop(): Promise<void> {
  while (true) {
    try {
      await runOneRound()
    } catch (e) {
      console.error('[Loop] Unhandled error in round, recovering in 2s:', e)
      await sleep(2_000)
    }
  }
}

async function runOneRound(): Promise<void> {
  const roundStart = Date.now()

  // ── PENDING → OPEN ──────────────────────────────────────────
  const position  = generatePosition()
  const openPrice = await fetchFreshPrice(position.pair)

  if (!openPrice) {
    console.warn('[Loop] Stale price at open — skipping round')
    await sleep(2_000)
    return
  }

  const roundNumber    = await db.rounds.getNextRoundNumber()
  const bettingClosesAt = new Date(roundStart + BETTING_DURATION_MS)
  const closesAt        = new Date(roundStart + ROUND_DURATION_MS)

  const round = await db.rounds.insert({
    round_number:      roundNumber,
    pair:              position.pair,
    direction:         position.direction,
    position_size:     position.size,
    leverage:          position.leverage,
    open_price:        openPrice.price,
    open_price_ts:     new Date(openPrice.timestamp),
    liq_price:         calcLiqPrice(position, openPrice.price),
    status:            'open',
    round_seed:        generateSeed(),
    betting_closes_at: bettingClosesAt,
    closes_at:         closesAt,
    opened_at:         new Date(roundStart),
    pos_pool:          0,
    neg_pool:          0,
    fee_collected:     0,
  })

  await broadcast.roundState(round)
  console.log(`[Loop] Round #${roundNumber} OPEN | ${position.direction.toUpperCase()} ${position.pair} $${position.size.toLocaleString()} @ ${position.leverage}x | liq: $${round.liq_price.toFixed(2)}`)

  // ── OPEN phase: tick prices every second ─────────────────────
  const tickInterval = setInterval(async () => {
    const price = await fetchFreshPrice(position.pair)
    if (price) {
      await broadcast.priceTick(round, price.price)
      await db.priceTicks.insert(round.id, price.price)
    }
  }, TICK_INTERVAL_MS)

  // ── OPEN → LOCKED ────────────────────────────────────────────
  await sleepUntil(bettingClosesAt)

  // Drift guard: if we're already past closes_at, settle immediately
  if (Date.now() > closesAt.getTime()) {
    clearInterval(tickInterval)
    await forceSettle(round)
    return
  }

  const pools = await db.rounds.getPools(round.id)

  if (pools.pos_pool === 0 && pools.neg_pool === 0) {
    clearInterval(tickInterval)
    await voidRound(round.id, 'no_bets')
    return
  }

  if (pools.pos_pool === 0 || pools.neg_pool === 0) {
    clearInterval(tickInterval)
    await voidRound(round.id, 'one_sided_pool')
    return
  }

  await db.rounds.update(round.id, { status: 'locked', locked_at: new Date() })
  await broadcast.roundState({ ...round, status: 'locked' })
  console.log(`[Loop] Round #${roundNumber} LOCKED | pos: $${pools.pos_pool} | neg: $${pools.neg_pool}`)

  // ── LOCKED → SETTLING ─────────────────────────────────────────
  await sleepUntil(closesAt)
  clearInterval(tickInterval)

  await db.rounds.update(round.id, { status: 'settling' })

  const closePrice = await fetchFreshPrice(position.pair)

  if (!closePrice) {
    await voidRound(round.id, 'stale_close_price')
    return
  }

  // ── SETTLING → SETTLED ────────────────────────────────────────
  const freshRound = await db.rounds.get(round.id)
  const result     = calculateResult(freshRound, openPrice.price, closePrice.price)
  await settleRound(freshRound, closePrice, result)
}

async function forceSettle(round: any): Promise<void> {
  console.log(`[Loop] Force settling overdue round #${round.round_number}`)
  await db.rounds.update(round.id, { status: 'settling' })
  const closePrice = await fetchFreshPrice(round.pair)
  if (!closePrice) {
    await voidRound(round.id, 'stale_close_price_force')
    return
  }
  const freshRound = await db.rounds.get(round.id)
  const result     = calculateResult(freshRound, round.open_price, closePrice.price)
  await settleRound(freshRound, closePrice, result)
}

function sleepUntil(target: Date): Promise<void> {
  const ms = target.getTime() - Date.now()
  return ms > 0 ? sleep(ms) : Promise.resolve()
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
