import { getSupabaseClient } from './db'
import { Round } from './types'
import crypto from 'crypto'

// Single smart market-maker wallet. Replaces the 4-bot LP system with a
// 3-phase approach that actively balances pools instead of random betting.
//
// Reuses one of the old LP wallets — it already has a balance in hl_balances,
// so no seeding is needed on the DB side.
const MM_WALLET = '0xa445042f03376353fa8f514b04e53d8e6b5f3846'

// ── PHASE TIMINGS ──────────────────────────────────────────────
// All three phases must fit inside BETTING_DURATION_MS (10s in loop.ts).
// If that window ever changes, adjust these accordingly.
const SEED_DELAY_MS    = 2_000  // open a token bet so the round isn't empty
const BALANCE_DELAY_MS = 5_000  // correct lopsided pools at the mid-point
const RESCUE_DELAY_MS  = 8_000  // last-second void-protection if a side is empty

// ── BET SIZES ──────────────────────────────────────────────────
const SEED_AMOUNT        = 1
const BALANCE_SMALL_AMT  = 1  // minor lopsidedness
const BALANCE_LARGE_AMT  = 2  // imbalance >= $3
const RESCUE_AMOUNT      = 1

// Smallest available balance the MM will fire with (hard floor — $1 is the
// minimum valid bet).
const MIN_BALANCE_FLOOR = 1

// ── REBALANCER ─────────────────────────────────────────────────
const REBALANCE_INTERVAL_MS = 5 * 60 * 1000
const REBALANCE_LOW    = 10
const REBALANCE_TARGET = 25
const REBALANCE_HIGH   = 60

// Capped top-ups — prevent runaway phantom printing against the treasury.
// Configurable via Railway env vars; defaults are conservative.
const MM_DAILY_TOPUP_CAP    = Number(process.env.MM_DAILY_TOPUP_CAP) || 20
const MM_LIFETIME_TOPUP_CAP = Number(process.env.MM_LIFETIME_TOPUP_CAP) || 100
const MM_TOPUPS_ENABLED     = process.env.MM_TOPUPS_ENABLED !== 'false'

function enabled(): boolean {
  // Defaults to enabled. Flip MM_ENABLED=false on Railway to kill.
  return process.env.MM_ENABLED !== 'false'
}

function short(): string {
  return `${MM_WALLET.slice(0, 6)}…${MM_WALLET.slice(-4)}`
}

async function getAvailable(): Promise<number> {
  const sb = getSupabaseClient()
  const { data } = await sb
    .from('hl_balances')
    .select('balance_usdc, locked_usdc')
    .eq('wallet', MM_WALLET)
    .single()
  return (Number(data?.balance_usdc) || 0) - (Number(data?.locked_usdc) || 0)
}

async function readRound(roundId: string): Promise<{ open: boolean; pos: number; neg: number }> {
  const sb = getSupabaseClient()
  const { data } = await sb
    .from('hl_rounds')
    .select('status, betting_closes_at, pos_pool, neg_pool')
    .eq('id', roundId)
    .single()

  if (!data || data.status !== 'open') return { open: false, pos: 0, neg: 0 }
  if (new Date(data.betting_closes_at).getTime() <= Date.now()) return { open: false, pos: 0, neg: 0 }

  return {
    open: true,
    pos: Number(data.pos_pool) || 0,
    neg: Number(data.neg_pool) || 0,
  }
}

async function placeMmBet(
  round: Round,
  side: 'pos' | 'neg',
  desired: number,
  phase: 'seed' | 'balance' | 'rescue',
  context: string,
): Promise<void> {
  const sb = getSupabaseClient()

  const available = await getAvailable()
  if (available < MIN_BALANCE_FLOOR) {
    console.log(`[MM] ${phase}: wallet below floor ($${available.toFixed(2)}) — skip (round #${round.round_number})`)
    return
  }

  const amount = Math.min(desired, Math.floor(available))
  if (amount < 1) return

  const { error } = await sb.rpc('hl_place_bet', {
    p_wallet: MM_WALLET,
    p_amount: amount,
    p_round_id: round.id,
    p_side: side,
    p_idempotency_key: crypto.randomUUID(),
  })

  if (error) {
    console.log(`[MM] ${phase}: bet declined (round #${round.round_number}): ${error.message}`)
    return
  }

  console.log(`[MM] ${phase}${context}: bet $${amount} on ${side} (round #${round.round_number})`)
}

// ── PER-ROUND SCHEDULER ────────────────────────────────────────
export function scheduleMarketMakerBets(round: Round): void {
  if (!enabled()) {
    console.log(`[MM] Round #${round.round_number}: MM_ENABLED=false — skipping`)
    return
  }

  const bettingClosesAt = new Date(round.betting_closes_at).getTime()
  const remaining = bettingClosesAt - Date.now()

  if (remaining < SEED_DELAY_MS + 500) {
    console.log(`[MM] Round #${round.round_number}: betting window too short (${remaining}ms), skipping`)
    return
  }

  // ── PHASE 1: SEED ──────────────────────────────────────────
  // At 2s, if no bets have landed yet, drop a $1 on a random side so the
  // pool has something to balance against.
  setTimeout(async () => {
    try {
      const state = await readRound(round.id)
      if (!state.open) return
      // Don't step on a human — if someone already bet, let the balance phase handle it
      if (state.pos + state.neg > 0) return
      const side: 'pos' | 'neg' = Math.random() < 0.5 ? 'pos' : 'neg'
      await placeMmBet(round, side, SEED_AMOUNT, 'seed', '')
    } catch (e: any) {
      console.warn('[MM] seed phase error:', e?.message || e)
    }
  }, SEED_DELAY_MS)

  // ── PHASE 2: BALANCE ───────────────────────────────────────
  // At 5s, if pools are lopsided, bet the minority side to shrink the
  // parimutuel arbitrage window.
  setTimeout(async () => {
    try {
      const state = await readRound(round.id)
      if (!state.open) return
      if (state.pos === state.neg) return
      const side: 'pos' | 'neg' = state.pos < state.neg ? 'pos' : 'neg'
      const imbalance = Math.abs(state.pos - state.neg)
      const amount = imbalance >= 3 ? BALANCE_LARGE_AMT : BALANCE_SMALL_AMT
      await placeMmBet(round, side, amount, 'balance', ` pos=$${state.pos} neg=$${state.neg}`)
    } catch (e: any) {
      console.warn('[MM] balance phase error:', e?.message || e)
    }
  }, BALANCE_DELAY_MS)

  // ── PHASE 3: RESCUE ────────────────────────────────────────
  // At 8s (2s before close), if one side is still empty, fill it. This is
  // the void-protection net — ensures the round settles normally and the
  // treasury collects the 7% rake.
  setTimeout(async () => {
    try {
      const state = await readRound(round.id)
      if (!state.open) return
      if (state.pos > 0 && state.neg > 0) return
      const side: 'pos' | 'neg' = state.pos === 0 ? 'pos' : 'neg'
      await placeMmBet(round, side, RESCUE_AMOUNT, 'rescue', ` pos=$${state.pos} neg=$${state.neg}`)
    } catch (e: any) {
      console.warn('[MM] rescue phase error:', e?.message || e)
    }
  }, RESCUE_DELAY_MS)
}

// ── REBALANCER ─────────────────────────────────────────────────
async function getTopUpTotals(): Promise<{ daily: number; lifetime: number }> {
  const sb = getSupabaseClient()

  const { data: lifetimeRows } = await sb
    .from('hl_lp_rebalance_log')
    .select('amount')
    .eq('wallet', MM_WALLET)
    .eq('action', 'topup')

  const lifetime = (lifetimeRows ?? []).reduce((s, r) => s + (Number(r.amount) || 0), 0)

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: dailyRows } = await sb
    .from('hl_lp_rebalance_log')
    .select('amount')
    .eq('wallet', MM_WALLET)
    .eq('action', 'topup')
    .gte('created_at', dayAgo)

  const daily = (dailyRows ?? []).reduce((s, r) => s + (Number(r.amount) || 0), 0)

  return { daily, lifetime }
}

export function startMarketMaker(): void {
  if (!enabled()) {
    console.log('[MM] MM_ENABLED=false — market maker disabled')
    return
  }

  console.log(`[MM] Market maker started (wallet ${short()})`)

  const tick = async () => {
    try {
      const sb = getSupabaseClient()
      const { data } = await sb
        .from('hl_balances')
        .select('balance_usdc')
        .eq('wallet', MM_WALLET)
        .single()

      const balance = Number(data?.balance_usdc) || 0

      // ── TOP-UP PATH ──
      if (balance < REBALANCE_LOW) {
        if (!MM_TOPUPS_ENABLED) {
          console.log(`[MM] low ($${balance.toFixed(2)}) but topups disabled`)
          return
        }

        const { daily, lifetime } = await getTopUpTotals()

        if (lifetime >= MM_LIFETIME_TOPUP_CAP) {
          console.log(`[MM] low ($${balance.toFixed(2)}) but LIFETIME cap reached ($${lifetime.toFixed(2)}/$${MM_LIFETIME_TOPUP_CAP})`)
          return
        }
        if (daily >= MM_DAILY_TOPUP_CAP) {
          console.log(`[MM] low ($${balance.toFixed(2)}) but DAILY cap reached ($${daily.toFixed(2)}/$${MM_DAILY_TOPUP_CAP})`)
          return
        }

        const needed = REBALANCE_TARGET - balance
        const dailyRoom = MM_DAILY_TOPUP_CAP - daily
        const lifetimeRoom = MM_LIFETIME_TOPUP_CAP - lifetime
        const topUp = Math.min(needed, dailyRoom, lifetimeRoom)

        if (topUp < 1) {
          console.log(`[MM] headroom too small ($${topUp.toFixed(2)})`)
          return
        }

        await sb.rpc('hl_increase_balance', { p_wallet: MM_WALLET, p_amount: topUp })

        await sb.from('hl_lp_rebalance_log').insert({
          wallet: MM_WALLET,
          action: 'topup',
          amount: topUp,
          balance_before: balance,
          balance_after: balance + topUp,
          note: `MM daily $${(daily + topUp).toFixed(2)}/$${MM_DAILY_TOPUP_CAP} | lifetime $${(lifetime + topUp).toFixed(2)}/$${MM_LIFETIME_TOPUP_CAP}`,
        })

        await sb.from('hl_transactions').insert({
          wallet: MM_WALLET,
          type: 'deposit',
          amount: topUp,
          note: 'mm rebalance (capped)',
        })

        console.log(`[MM] Topped ${short()}: $${balance.toFixed(2)} → $${(balance + topUp).toFixed(2)} (printed $${topUp.toFixed(2)}, daily $${(daily + topUp).toFixed(2)}/$${MM_DAILY_TOPUP_CAP})`)

      // ── SKIM PATH (MM got hot — profit, no cap needed) ──
      } else if (balance > REBALANCE_HIGH) {
        const skim = balance - REBALANCE_TARGET
        await sb.from('hl_balances')
          .update({ balance_usdc: REBALANCE_TARGET, updated_at: new Date().toISOString() })
          .eq('wallet', MM_WALLET)

        await sb.from('hl_lp_rebalance_log').insert({
          wallet: MM_WALLET,
          action: 'skim',
          amount: skim,
          balance_before: balance,
          balance_after: REBALANCE_TARGET,
          note: 'MM skim — got hot',
        })

        await sb.from('hl_transactions').insert({
          wallet: MM_WALLET,
          type: 'withdraw',
          amount: skim,
          note: 'mm rebalance skim',
        })

        console.log(`[MM] Skimmed ${short()}: $${balance.toFixed(2)} → $${REBALANCE_TARGET}`)
      }
    } catch (e) {
      console.warn('[MM] Rebalance tick failed:', e)
    }
  }

  tick()
  setInterval(tick, REBALANCE_INTERVAL_MS)
  console.log(`[MM] Rebalancer started — daily cap $${MM_DAILY_TOPUP_CAP}, lifetime cap $${MM_LIFETIME_TOPUP_CAP}, topups ${MM_TOPUPS_ENABLED ? 'ON' : 'OFF'}`)
}
