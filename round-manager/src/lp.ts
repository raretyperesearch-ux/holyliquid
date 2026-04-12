import { getSupabaseClient } from './db'
import { Round } from './types'
import crypto from 'crypto'

// Liquidity provider wallets — seeded in hl_balances with $25 each.
const LP_WALLETS = [
  '0xf89490b133654ceb096675bd60e0783f595ce00c',
  '0xa445042f03376353fa8f514b04e53d8e6b5f3846',
  '0x5c405cbfe708ed805cd839930953e00c66364048',
  '0xdaaf396675fe6324dce078e20745603d4f198482',
]

// Bet sizes — capped at $2 max to limit exposure per round.
const BET_AMOUNTS = [1, 1, 1, 1, 2, 2]

// Each LP bets on this fraction of rounds (independent per wallet).
const BET_PROBABILITY = 0.45

// Random delay (ms) after a round opens before an LP fires its bet.
const MIN_DELAY_MS = 2500
const MAX_DELAY_MS = 8000

// Don't let any wallet drop below this balance — sit out until rebalanced.
const MIN_BALANCE_FLOOR = 5

// Rebalance bounds. If a wallet drifts outside these, nudge back to $25.
const REBALANCE_LOW  = 10
const REBALANCE_HIGH = 60
const REBALANCE_TARGET = 25

// Daily loss cap per wallet. If an LP loses more than this in a 24h window,
// it sits out until the window resets. Prevents runaway bleeding.
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
 * Schedule LP bets for a freshly-opened round. Fires bets on a random delay
 * within the betting window so they don't cluster at t=0.
 *
 * Safe to call even if LP_ENABLED is false — it no-ops.
 */
export function scheduleLpBets(round: Round): void {
  if (process.env.LP_ENABLED !== 'true') return

  const bettingClosesAt = new Date(round.betting_closes_at).getTime()
  const now = Date.now()
  const remainingWindow = bettingClosesAt - now

  if (remainingWindow < MIN_DELAY_MS + 500) {
    console.log(`[LP] Round #${round.round_number}: window too short (${remainingWindow}ms), skipping`)
    return
  }

  for (const wallet of LP_WALLETS) {
    if (Math.random() > BET_PROBABILITY) continue

    // Check daily loss cap before even scheduling
    if (getDailyLoss(wallet) >= DAILY_LOSS_CAP) continue

    const maxDelay = Math.min(MAX_DELAY_MS, remainingWindow - 500)
    const delay = randomInt(MIN_DELAY_MS, maxDelay)

    setTimeout(() => {
      placeLpBet(wallet, round).catch(err => {
        console.warn(`[LP] ${shortWallet(wallet)} bet failed:`, err?.message || err)
      })
    }, delay)
  }
}

async function placeLpBet(wallet: string, round: Round): Promise<void> {
  const sb = getSupabaseClient()

  // Re-check daily loss cap (could have changed since scheduling)
  if (getDailyLoss(wallet) >= DAILY_LOSS_CAP) return

  const { data: bal } = await sb
    .from('hl_balances')
    .select('balance_usdc, locked_usdc')
    .eq('wallet', wallet)
    .single()

  const available = (Number(bal?.balance_usdc) || 0) - (Number(bal?.locked_usdc) || 0)
  if (available < MIN_BALANCE_FLOOR) {
    console.log(`[LP] ${shortWallet(wallet)} below floor ($${available.toFixed(2)}) — sitting out`)
    return
  }

  const amount = Math.min(random(BET_AMOUNTS), Math.floor(available))
  if (amount < 1) return

  // Verify the round is still open AND read the live pool split
  const { data: roundCheck } = await sb
    .from('hl_rounds')
    .select('status, betting_closes_at, pos_pool, neg_pool')
    .eq('id', round.id)
    .single()

  if (!roundCheck || roundCheck.status !== 'open') return
  if (new Date(roundCheck.betting_closes_at).getTime() <= Date.now()) return

  // Smart side selection: bet the MINORITY side to provide liquidity.
  // If pools are equal or both empty, pick randomly.
  // This gives a slight contrarian edge and — more importantly — prevents
  // one-sided rounds from being voided (which wastes everyone's time).
  const posPool = Number(roundCheck.pos_pool) || 0
  const negPool = Number(roundCheck.neg_pool) || 0
  let side: 'pos' | 'neg'
  if (posPool === negPool) {
    side = Math.random() < 0.5 ? 'pos' : 'neg'
  } else {
    // 80% chance to bet the minority side, 20% random (so it's not 100% predictable)
    const minoritySide: 'pos' | 'neg' = posPool < negPool ? 'pos' : 'neg'
    side = Math.random() < 0.8 ? minoritySide : (minoritySide === 'pos' ? 'neg' : 'pos')
  }

  const { error } = await sb.rpc('hl_place_bet', {
    p_wallet: wallet,
    p_amount: amount,
    p_round_id: round.id,
    p_side: side,
    p_idempotency_key: crypto.randomUUID(),
  })

  if (error) {
    console.log(`[LP] ${shortWallet(wallet)} bet declined: ${error.message}`)
    return
  }

  console.log(`[LP] ${shortWallet(wallet)} bet $${amount} on ${side} (round #${round.round_number}, pools: +${posPool}/-${negPool})`)
}

/**
 * Called by the settle flow (via round-manager events) to track LP losses.
 * Non-LPs are ignored. This is a best-effort in-memory tracker — resets
 * on Railway restart, which is fine (conservative: LPs bet again after restart).
 */
export function trackLpSettlement(wallet: string, won: boolean, amount: number) {
  if (!LP_WALLETS.includes(wallet)) return
  if (!won) {
    recordLoss(wallet, amount)
  }
}

/**
 * Periodically rebalance LP wallets that have drifted too high or too low.
 * Call once at startup; it self-schedules.
 */
export function startLpRebalancer(): void {
  if (process.env.LP_ENABLED !== 'true') return

  const REBALANCE_INTERVAL_MS = 5 * 60 * 1000

  const tick = async () => {
    try {
      const sb = getSupabaseClient()
      const { data: rows } = await sb
        .from('hl_balances')
        .select('wallet, balance_usdc')
        .in('wallet', LP_WALLETS)

      for (const row of rows ?? []) {
        const balance = Number(row.balance_usdc)
        if (balance < REBALANCE_LOW) {
          const topUp = REBALANCE_TARGET - balance
          await sb.rpc('hl_increase_balance', { p_wallet: row.wallet, p_amount: topUp })
          await sb.from('hl_transactions').insert({
            wallet: row.wallet, type: 'deposit', amount: topUp, note: 'lp rebalance',
          })
          console.log(`[LP] Rebalanced ${shortWallet(row.wallet)}: $${balance.toFixed(2)} → $${REBALANCE_TARGET}`)
        } else if (balance > REBALANCE_HIGH) {
          const skim = balance - REBALANCE_TARGET
          await sb.from('hl_balances')
            .update({ balance_usdc: REBALANCE_TARGET, updated_at: new Date().toISOString() })
            .eq('wallet', row.wallet)
          await sb.from('hl_transactions').insert({
            wallet: row.wallet, type: 'withdraw', amount: skim, note: 'lp rebalance',
          })
          console.log(`[LP] Skimmed ${shortWallet(row.wallet)}: $${balance.toFixed(2)} → $${REBALANCE_TARGET}`)
        }
      }
    } catch (e) {
      console.warn('[LP] Rebalance tick failed:', e)
    }
  }

  tick()
  setInterval(tick, REBALANCE_INTERVAL_MS)
  console.log('[LP] Rebalancer started')
}

function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}
