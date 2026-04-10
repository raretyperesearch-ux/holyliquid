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
    })
  } catch (e) {
    return serverError(e)
  }
}
