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

// Rebalance bounds.
const REBALANCE_LOW  = 10
const REBALANCE_HIGH = 60
const REBALANCE_TARGET = 25

// Top-up caps — prevent infinite phantom money printing against treasury.
// Configurable via Railway env vars; defaults are conservative.
const LP_DAILY_TOPUP_CAP    = Number(process.env.LP_DAILY_TOPUP_CAP) || 20
const LP_LIFETIME_TOPUP_CAP = Number(process.env.LP_LIFETIME_TOPUP_CAP) || 100
const LP_TOPUPS_ENABLED      = process.env.LP_TOPUPS_ENABLED !== 'false' // default true

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

// ── BETTING LOGIC ──────────────────────────────────────────────

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

  const { data: roundCheck } = await sb
    .from('hl_rounds')
    .select('status, betting_closes_at, pos_pool, neg_pool')
    .eq('id', round.id)
    .single()

  if (!roundCheck || roundCheck.status !== 'open') return
  if (new Date(roundCheck.betting_closes_at).getTime() <= Date.now()) return

  // Smart side: bet the minority side 80% of the time
  const posPool = Number(roundCheck.pos_pool) || 0
  const negPool = Number(roundCheck.neg_pool) || 0
  let side: 'pos' | 'neg'
  if (posPool === negPool) {
    side = Math.random() < 0.5 ? 'pos' : 'neg'
  } else {
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

export function trackLpSettlement(wallet: string, won: boolean, amount: number) {
  if (!LP_WALLETS.includes(wallet)) return
  if (!won) {
    recordLoss(wallet, amount)
  }
}

// ── REBALANCER WITH CAPPED TOP-UPS ────────────────────────────

/**
 * Reads how much has been topped up for a wallet today and lifetime
 * from hl_lp_rebalance_log. Returns { daily, lifetime }.
 */
async function getTopUpTotals(wallet: string): Promise<{ daily: number; lifetime: number }> {
  const sb = getSupabaseClient()

  // Lifetime total
  const { data: lifetimeRows } = await sb
    .from('hl_lp_rebalance_log')
    .select('amount')
    .eq('wallet', wallet)
    .eq('action', 'topup')

  const lifetime = (lifetimeRows ?? []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  // Daily total (last 24h)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: dailyRows } = await sb
    .from('hl_lp_rebalance_log')
    .select('amount')
    .eq('wallet', wallet)
    .eq('action', 'topup')
    .gte('created_at', dayAgo)

  const daily = (dailyRows ?? []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0)

  return { daily, lifetime }
}

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

        // ── TOP-UP PATH (balance too low) ──
        if (balance < REBALANCE_LOW) {
          if (!LP_TOPUPS_ENABLED) {
            console.log(`[LP] ${shortWallet(row.wallet)} low ($${balance.toFixed(2)}) but topups disabled`)
            continue
          }

          const topUpNeeded = REBALANCE_TARGET - balance
          const { daily, lifetime } = await getTopUpTotals(row.wallet)

          // Check lifetime cap
          if (lifetime >= LP_LIFETIME_TOPUP_CAP) {
            console.log(`[LP] ${shortWallet(row.wallet)} low ($${balance.toFixed(2)}) but LIFETIME cap reached. Lifetime: $${lifetime.toFixed(2)}/$${LP_LIFETIME_TOPUP_CAP}`)
            continue
          }

          // Check daily cap
          if (daily >= LP_DAILY_TOPUP_CAP) {
            console.log(`[LP] ${shortWallet(row.wallet)} low ($${balance.toFixed(2)}) but cap reached. Daily: $${daily.toFixed(2)}/$${LP_DAILY_TOPUP_CAP} | Lifetime: $${lifetime.toFixed(2)}/$${LP_LIFETIME_TOPUP_CAP}`)
            continue
          }

          // Clamp top-up to not exceed either cap
          const dailyHeadroom = LP_DAILY_TOPUP_CAP - daily
          const lifetimeHeadroom = LP_LIFETIME_TOPUP_CAP - lifetime
          const topUp = Math.min(topUpNeeded, dailyHeadroom, lifetimeHeadroom)

          if (topUp < 1) {
            console.log(`[LP] ${shortWallet(row.wallet)} low ($${balance.toFixed(2)}) but headroom too small ($${topUp.toFixed(2)})`)
            continue
          }

          // Execute the top-up
          await sb.rpc('hl_increase_balance', { p_wallet: row.wallet, p_amount: topUp })

          // Log to hl_lp_rebalance_log for cap tracking
          await sb.from('hl_lp_rebalance_log').insert({
            wallet: row.wallet,
            action: 'topup',
            amount: topUp,
            balance_before: balance,
            balance_after: balance + topUp,
            note: `daily $${(daily + topUp).toFixed(2)}/$${LP_DAILY_TOPUP_CAP} | lifetime $${(lifetime + topUp).toFixed(2)}/$${LP_LIFETIME_TOPUP_CAP}`,
          })

          // Also log to hl_transactions for the audit trail
          await sb.from('hl_transactions').insert({
            wallet: row.wallet, type: 'deposit', amount: topUp, note: 'lp rebalance (capped)',
          })

          console.log(`[LP] Topped ${shortWallet(row.wallet)}: $${balance.toFixed(2)} → $${(balance + topUp).toFixed(2)} (printed $${topUp.toFixed(2)}, daily $${(daily + topUp).toFixed(2)}/$${LP_DAILY_TOPUP_CAP})`)

        // ── SKIM PATH (balance too high) — no cap needed, this is profit ──
        } else if (balance > REBALANCE_HIGH) {
          const skim = balance - REBALANCE_TARGET
          await sb.from('hl_balances')
            .update({ balance_usdc: REBALANCE_TARGET, updated_at: new Date().toISOString() })
            .eq('wallet', row.wallet)

          // Log skim to rebalance log too (for completeness)
          await sb.from('hl_lp_rebalance_log').insert({
            wallet: row.wallet,
            action: 'skim',
            amount: skim,
            balance_before: balance,
            balance_after: REBALANCE_TARGET,
            note: 'skim — LP got hot',
          })

          await sb.from('hl_transactions').insert({
            wallet: row.wallet, type: 'withdraw', amount: skim, note: 'lp rebalance skim',
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
  console.log(`[LP] Rebalancer started — daily cap $${LP_DAILY_TOPUP_CAP}, lifetime cap $${LP_LIFETIME_TOPUP_CAP}, topups ${LP_TOPUPS_ENABLED ? 'ON' : 'OFF'}`)
}

function shortWallet(w: string): string {
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}
