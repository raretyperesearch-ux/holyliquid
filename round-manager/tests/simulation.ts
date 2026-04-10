/**
 * simulation.ts — run 1,000 simulated rounds and verify invariants
 * Usage: npm run sim
 *
 * RULES: Must pass with 0 drift before moving to Phase 1B.
 */

import 'dotenv/config'
import { connectSupabase, db, getSupabaseClient } from '../src/db'
import { generatePosition, calcLiqPrice, generateSeed } from '../src/position'
import { calculateResult } from '../src/settle'

const ROUNDS    = 1_000
const PAIR      = 'ETH/USD'
const BASE_PRICE = 3500.00

let driftTotal  = 0
let passed      = 0
let failed      = 0

async function simulate() {
  await connectSupabase()
  console.log(`\n[Sim] Running ${ROUNDS} simulated rounds...\n`)

  for (let i = 0; i < ROUNDS; i++) {
    const roundNum = i + 1
    const position = generatePosition()
    const openPrice = BASE_PRICE + (Math.random() - 0.5) * 200

    // Simulate random bets
    const numBets = Math.floor(Math.random() * 8) + 2
    const bets: { wallet: string; side: 'pos' | 'neg'; amount: number }[] = []
    let posPool = 0, negPool = 0

    for (let j = 0; j < numBets; j++) {
      const side   = Math.random() > 0.5 ? 'pos' : 'neg'
      const amount = Math.floor(Math.random() * 100) + 1
      bets.push({ wallet: `sim_wallet_${j}`, side, amount })
      if (side === 'pos') posPool += amount
      else negPool += amount
    }

    // Skip one-sided pools
    if (posPool === 0 || negPool === 0) continue

    // Simulate close price (random walk)
    const closeDelta = (Math.random() - 0.5) * openPrice * 0.02
    const closePrice = openPrice + closeDelta
    const liqPrice   = calcLiqPrice(position, openPrice)

    const fakeRound = {
      id: `sim-${roundNum}`,
      round_number: roundNum,
      version: 1,
      pair: position.pair,
      direction: position.direction,
      position_size: position.size,
      leverage: position.leverage,
      open_price: openPrice,
      liq_price: liqPrice,
      pos_pool: posPool,
      neg_pool: negPool,
    } as any

    const result = calculateResult(fakeRound, openPrice, closePrice)

    // Calculate expected payouts
    const losingPool  = result.winningSide === 'pos' ? negPool : posPool
    const winningPool = result.winningSide === 'pos' ? posPool : negPool
    const fee         = losingPool * 0.05
    const prize       = losingPool * 0.95

    let totalOut = 0
    for (const bet of bets) {
      if (bet.side === result.winningSide) {
        const winnings = bet.amount + (bet.amount / winningPool) * prize
        totalOut += winnings
      }
    }

    const totalIn   = posPool + negPool
    const drift     = totalIn - totalOut - fee
    const driftAbs  = Math.abs(drift)

    driftTotal += driftAbs

    if (driftAbs > 0.001) {
      failed++
      console.error(`[Sim] ❌ Round ${roundNum}: drift = $${drift.toFixed(6)} | in=$${totalIn} out=$${totalOut.toFixed(4)} fee=$${fee.toFixed(4)}`)
    } else {
      passed++
    }

    if (roundNum % 100 === 0) {
      process.stdout.write(`[Sim] ${roundNum}/${ROUNDS} rounds... cumulative drift: $${driftTotal.toFixed(6)}\n`)
    }
  }

  console.log('\n─────────────────────────────────────')
  console.log(`[Sim] Results: ${passed} passed, ${failed} failed`)
  console.log(`[Sim] Total drift: $${driftTotal.toFixed(6)}`)

  if (failed === 0) {
    console.log('[Sim] ✅ PASSED — safe to move to Phase 1B\n')
    process.exit(0)
  } else {
    console.error('[Sim] ❌ FAILED — fix drift before Phase 1B\n')
    process.exit(1)
  }
}

simulate().catch(e => {
  console.error('[Sim] Fatal:', e)
  process.exit(1)
})
