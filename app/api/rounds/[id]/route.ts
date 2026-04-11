import { NextRequest } from 'next/server'
import { ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const sb = createServerSupabase()

    const { data: round, error } = await sb
      .from('hl_rounds')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !round) return badRequest('Round not found')

    const { data: bets } = await sb
      .from('hl_bets')
      .select('side, amount, won, outcome, winnings')
      .eq('round_id', id)

    const posBets = (bets || []).filter(b => b.side === 'pos')
    const negBets = (bets || []).filter(b => b.side === 'neg')

    // Optional auth — if a Bearer token is present, also return my_bet
    let myBet: {
      side: 'pos' | 'neg'
      amount: number
      won: boolean | null
      outcome: string | null
      winnings: number
    } | null = null
    try {
      const { verifyAuth } = await import('@/lib/auth')
      const wallet = await verifyAuth(req)
      const { data: bet } = await sb
        .from('hl_bets')
        .select('side, amount, won, outcome, winnings')
        .eq('round_id', id)
        .eq('wallet', wallet)
        .single()
      if (bet) {
        myBet = {
          side:    bet.side as 'pos' | 'neg',
          amount:  Number(bet.amount) || 0,
          won:     bet.won,
          outcome: bet.outcome,
          winnings: Number(bet.winnings) || 0,
        }
      }
    } catch {
      // No auth or auth failed — that's fine, my_bet stays null
    }

    return ok({
      round: {
        ...round,
        position_size: Number(round.position_size),
        open_price:    Number(round.open_price),
        close_price:   round.close_price ? Number(round.close_price) : null,
        liq_price:     round.liq_price ? Number(round.liq_price) : null,
        pos_pool:      Number(round.pos_pool),
        neg_pool:      Number(round.neg_pool),
        fee_collected: Number(round.fee_collected),
      },
      bets_summary: {
        total:     (bets || []).length,
        pos_count: posBets.length,
        neg_count: negBets.length,
      },
      my_bet: myBet,
    })
  } catch (e) {
    return serverError(e)
  }
}
