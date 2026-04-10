import { NextRequest } from 'next/server'
import { ok, serverError } from '@/lib/auth'

const ORACLE_URL = process.env.ORACLE_SERVICE_URL || 'http://localhost:8000'

export async function GET(req: NextRequest) {
  try {
    // Get wallet from optional auth header (not required for viewing)
    let wallet: string | null = null
    try {
      const { verifyAuth } = await import('@/lib/auth')
      wallet = await verifyAuth(req)
    } catch {}

    const { createServerSupabase } = await import('@/lib/supabase/server')
    const sb = createServerSupabase()

    // Get most recent non-void round
    const { data: round, error } = await sb
      .from('hl_rounds')
      .select('*')
      .in('status', ['open', 'locked', 'settling', 'settled'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (error && error.code !== 'PGRST116') throw error
    if (!round) return ok({ round: null })

    // Get current price from oracle
    let currentPrice = round.open_price
    try {
      const res = await fetch(`${ORACLE_URL}/prices`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) {
        const prices = await res.json() as Record<string, any>
        currentPrice = prices[round.pair]?.price ?? round.open_price
      }
    } catch {}

    // Calculate live PnL
    const priceChange = (currentPrice - round.open_price) / round.open_price
    const dirMult = round.direction === 'long' ? 1 : -1
    const pnlUsd = round.position_size * priceChange * dirMult
    const pnlPct = priceChange * round.leverage * dirMult * 100

    const now = Date.now()
    const bettingClosesAt = new Date(round.betting_closes_at).getTime()
    const closesAt = new Date(round.closes_at).getTime()

    const roundData = {
      id:               round.id,
      round_number:     round.round_number,
      version:          round.version,
      pair:             round.pair,
      direction:        round.direction,
      position_size:    Number(round.position_size),
      leverage:         round.leverage,
      liq_price:        Number(round.liq_price),
      open_price:       Number(round.open_price),
      open_price_ts:    round.open_price_ts,
      current_price:    currentPrice,
      current_value:    Number(round.position_size) + pnlUsd,
      pnl_usd:          pnlUsd,
      pnl_pct:          pnlPct,
      pos_pool:         Number(round.pos_pool),
      neg_pool:         Number(round.neg_pool),
      status:           round.status,
      round_seed:       round.round_seed,
      result:           round.result,
      betting_closes_at: round.betting_closes_at,
      closes_at:        round.closes_at,
      ms_until_lock:    Math.max(0, bettingClosesAt - now),
      ms_until_close:   Math.max(0, closesAt - now),
    }

    // Include player's bet if authenticated
    let myBet = null
    if (wallet) {
      const { data: bet } = await sb
        .from('hl_bets')
        .select('side, amount, winnings, won, outcome')
        .eq('round_id', round.id)
        .eq('wallet', wallet)
        .single()

      if (bet) {
        const winPool = bet.side === 'pos' ? round.pos_pool : round.neg_pool
        const losePool = bet.side === 'pos' ? round.neg_pool : round.pos_pool
        const estimatedWinnings = winPool > 0
          ? bet.amount + (bet.amount / winPool) * (losePool * 0.95)
          : bet.amount

        myBet = {
          side:               bet.side,
          amount:             Number(bet.amount),
          estimated_winnings: estimatedWinnings,
          won:                bet.won,
          outcome:            bet.outcome,
          actual_winnings:    bet.winnings ? Number(bet.winnings) : null,
        }
      }
    }

    return ok({ round: roundData, my_bet: myBet })
  } catch (e) {
    return serverError(e)
  }
}
