import { NextRequest } from 'next/server'
import { ok, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const limit  = Math.min(parseInt(searchParams.get('limit')  ?? '20'), 50)
    const offset = parseInt(searchParams.get('offset') ?? '0')

    const sb = createServerSupabase()

    const { data, error, count } = await sb
      .from('hl_rounds')
      .select('*', { count: 'exact' })
      .in('status', ['settled', 'void'])
      .order('round_number', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error

    const rounds = (data || []).map(r => ({
      round_number:  r.round_number,
      pair:          r.pair,
      direction:     r.direction,
      leverage:      r.leverage,
      position_size: Number(r.position_size),
      open_price:    Number(r.open_price),
      close_price:   r.close_price ? Number(r.close_price) : null,
      liq_price:     r.liq_price ? Number(r.liq_price) : null,
      result:        r.result,
      pnl_usd:       r.pnl_usd ? Number(r.pnl_usd) : null,
      pnl_pct:       r.pnl_pct ? Number(r.pnl_pct) : null,
      pos_pool:      Number(r.pos_pool),
      neg_pool:      Number(r.neg_pool),
      fee_collected: Number(r.fee_collected),
      status:        r.status,
      void_reason:   r.void_reason,
      settled_at:    r.settled_at,
      created_at:    r.created_at,
    }))

    return ok({ rounds, total: count ?? 0, limit, offset })
  } catch (e) {
    return serverError(e)
  }
}
