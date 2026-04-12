import { db, getSupabaseClient } from './db'
import { Round } from './types'
import crypto from 'crypto'

// 4 seeded bot wallets. Balances tracked in hl_balances like any other wallet.
const BOT_WALLETS = [
  '0xb07a000000000000000000000000000000007001',
  '0xb07a000000000000000000000000000000007002',
  '0xb07a000000000000000000000000000000007003',
  '0xb07a000000000000000000000000000000007004',
]

// Bet sizes — capped at $2 max to limit exposure per round.
const BET_AMOUNTS = [1, 1, 1, 1, 2, 2]

// Each bot bets on this fraction of rounds (independent per bot).
const BET_PROBABILITY = 0.45

// Random delay (ms) after a round opens before a bot fires its bet.
const MIN_DELAY_MS = 2500
const MAX_DELAY_MS = 8000

// Don't let any bot drop below this balance — they sit out until rebalanced.
const MIN_BALANCE_FLOOR = 5

// Rebalance bounds.
const REBALANCE_LOW  = 10
const REBALANCE_HIGH = 60
const REBALANCE_TARGET = 25

// Daily loss cap per wallet. Prevents runaway bleeding against humans.
const DAILY_LOSS_CAP = 10
const dailyLosses = new Map<string, { total: number; resetAt: number }>()

function getDailyLoss(wallet: string): number {
  const entry = dailyLosses.get(wallet)
  if (!entry || Date.now() > entry.resetAt) {
    dailyLosses.set(wallet, { total: 0, resetAt: Date.now() + 24 * 60 * 60 * 1000 })
    return 0
  }
  return entry.total
}

function recordLoss(wallet: string, amount: number) {
  const entry = dailyLosses.get(wallet)
  if (entry && Date.now() <= entry.resetAt) {
    entry.total += amount
  } else {
    dailyLosses.set(wallet, { total: amount, resetAt: Date.now() + 24 * 60 * 60 * 1000 })
  }
}

const random = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min

/**
 * Schedule bot bets for a freshly-opened round.
 * Safe to call even if BOTS_ENABLED is false — it no-ops.
 */
export function scheduleBotBets(round: Round): void {
  if (process.env.BOTS_ENABLED !== 'true') {
    console.log(`[Bots] Round #${round.round_number}: BOTS_ENABLED is not 'true' — skipping`)
    return
  }

  const bettingClosesAt = new Date(round.betting_closes_at).getTime()
  const now = Date.now()
  const remainingWindow = bettingClosesAt - now

  if (remainingWindow < MIN_DELAY_MS + 500) {
    console.log(`[Bots] Round #${round.round_number}: betting window too short (${remainingWindow}ms), skipping`)
    return
  }

  const maxDelay = Math.min(MAX_DELAY_MS, remainingWindow - 500)
  const schedule = (wallet: string, force = false) => {
    const delay = randomInt(MIN_DELAY_MS, maxDelay)
    setTimeout(() => {
      placeBotBet(wallet, round, force).catch(err => {
        console.warn(`[Bots] ${shortWallet(wallet)} bet failed:`, err?.message || err)
      })
    }, delay)
  }

  let scheduledCount = 0
  for (const wallet of BOT_WALLETS) {
    if (Math.random() > BET_PROBABILITY) continue
    if (getDailyLoss(wallet) >= DAILY_LOSS_CAP) continue
    schedule(wallet)
    scheduledCount++
  }

  // Guarantee at least one bot fires per round so every round has action.
  // Forced bets bypass the balance floor (they only need >= $1 to fire).
  if (scheduledCount === 0) {
    const eligible = BOT_WALLETS.filter(w => getDailyLoss(w) < DAILY_LOSS_CAP)
    if (eligible.length > 0) {
      const wallet = random(eligible)
      schedule(wallet, true)
      console.log(`[Bots] Round #${round.round_number}: forcing ${shortWallet(wallet)} to guarantee action`)
    } else {
      console.log(`[Bots] Round #${round.round_number}: all bots over daily loss cap, no forced bet`)
    }
  }
}

async function placeBotBet(wallet: string, round: Round, force = false): Promise<void> {
  const sb = getSupabaseClient()

  if (getDailyLoss(wallet) >= DAILY_LOSS_CAP) return

  const { data: bal } = await sb
    .from('hl_balances')
    .select('balance_usdc, locked_usdc')
    .eq('wallet', wallet)
    .single()

  const available = (Number(bal?.balance_usdc) || 0) - (Number(bal?.locked_usdc) || 0)
  // Forced bets bypass the soft floor — they only need >= $1 to place something.
  const floor = force ? 1 : MIN_BALANCE_FLOOR
  if (available < floor) {
    console.log(`[Bots] ${shortWallet(wallet)} below floor ($${available.toFixed(2)}${force ? ', forced' : ''}) — sitting out`)
    return
  }

  // Read live pool split for smart side selection
  const { data: roundCheck } = await sb
    .from('hl_rounds')
    .select('status, betting_closes_at, pos_pool, neg_pool')
    .eq('id', round.id)
    .single()

  if (!roundCheck || roundCheck.status !== 'open') return
  if (new Date(roundCheck.betting_closes_at).getTime() <= Date.now()) return

  // POOL BALANCING — always bet minority side, scale size with imbalance.
  // Closes the parimutuel arbitrage where humans bet the underdog for outsized
  // payouts on lopsided pools.
  const posPool = Number(roundCheck.pos_pool) || 0
  const negPool = Number(roundCheck.neg_pool) || 0
  const imbalance = Math.abs(posPool - negPool)

  let side: 'pos' | 'neg'
  let amount: number

  if (posPool === negPool) {
    side = Math.random() < 0.5 ? 'pos' : 'neg'
    amount = Math.min(random(BET_AMOUNTS), Math.floor(available))
  } else {
    side = posPool < negPool ? 'pos' : 'neg'
    if (imbalance >= 10) {
      amount = Math.min(5, Math.floor(available))
    } else if (imbalance >= 5) {
      amount = Math.min(3, Math.floor(available))
    } else {
      amount = Math.min(random(BET_AMOUNTS), Math.floor(available))
    }
  }

  if (amount < 1) return

  const { error } = await sb.rpc('hl_place_bet', {
    p_wallet: wallet,
    p_amount: amount,
    p_round_id: round.id,
    p_side: side,
    p_idempotency_key: crypto.randomUUID(),
  })

  if (error) {
    console.log(`[Bots] ${shortWallet(wallet)} bet declined: ${error.message}`)
    return
  }

  console.log(`[Bots] ${shortWallet(wallet)} bet $${amount} on ${side} (round #${round.round_number}, pools: +${posPool}/-${negPool})`)
}

/**
 * Called by the settle flow to track bot losses for the daily cap.
 */
export function trackBotSettlement(wallet: string, won: boolean, amount: number) {
  if (!BOT_WALLETS.includes(wallet)) return
  if (!won) {
    recordLoss(wallet, amount)
  }
}

/**
 * Periodically rebalance bot wallets.
 * Call once at startup; it self-schedules.
 */
export function startBotRebalancer(): void {
  if (process.env.BOTS_ENABLED !== 'true') return

  const REBALANCE_INTERVAL_MS = 5 * 60 * 1000

  const tick = async () => {
    try {
      const sb = getSupabaseClient()
      const { data: rows } = await sb
        .from('hl_balances')
        .select('wallet, balance_usdc')
        .in('wallet', BOT_WALLETS)

      for (const row of rows ?? []) {
        const balance = Number(row.balance_usdc)
        if (balance < REBALANCE_LOW) {
          const topUp = REBALANCE_TARGET - balance
          await sb.rpc('hl_increase_balance', { p_wallet: row.wallet, p_amount: topUp })
          await sb.from('hl_transactions').insert({
            wallet: row.wallet, type: 'deposit', amount: topUp, note: 'bot rebalance top-up',
          })
          console.log(`[Bots] Rebalanced ${shortWallet(row.wallet)}: $${balance.toFixed(2)} → $${REBALANCE_TARGET}`)
        } else if (balance > REBALANCE_HIGH) {
          const skim = balance - REBALANCE_TARGET
          await sb.from('hl_balances')
            .update({ balance_usdc: REBALANCE_TARGET, updated_at: new Date().toISOString() })
            .eq('wallet', row.wallet)
          await sb.from('hl_transactions').insert({
            wallet: row.wallet, type: 'withdraw', amount: skim, note: 'bot rebalance skim',
          })
          console.log(`[Bots] Skimmed ${shortWallet(row.wallet)}: $${balance.toFixed(2)} → $${REBALANCE_TARGET}`)
        }
      }
    } catch (e) {
      console.warn('[Bots] Rebalance tick failed:', e)
    }
  }

  tick()
  setInterval(tick, REBALANCE_INTERVAL_MS)
  console.log('[Bots] Rebalancer started — will tick every 5 minutes')
}

function shortWallet(w: string): string {
  return `bot:${w.slice(-4)}`
}
