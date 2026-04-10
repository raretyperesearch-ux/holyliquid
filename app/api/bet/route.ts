import { NextRequest } from 'next/server'
import { verifyAuth, unauthorized, ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'

const MIN_BET = 1
const MAX_BET = 500

export async function POST(req: NextRequest) {
  try {
    const wallet = await verifyAuth(req)
    const body = await req.json()
    const { round_id, side, amount, idempotency_key } = body

    // Validate inputs
    if (!round_id) return badRequest('round_id required')
    if (!side || !['pos', 'neg'].includes(side)) return badRequest('side must be pos or neg')
    if (!idempotency_key) return badRequest('idempotency_key required')
    if (!amount || amount < MIN_BET) return badRequest(`Minimum bet is $${MIN_BET}`)
    if (amount > MAX_BET) return badRequest(`Maximum bet is $${MAX_BET}`)

    const sb = createServerSupabase()

    // Check idempotency — return existing bet if key already used
    const { data: existing } = await sb
      .from('hl_bets')
      .select('id, round_id, side, amount')
      .eq('idempotency_key', idempotency_key)
      .single()

    if (existing) {
      return Response.json(
        { success: true, data: existing, idempotent: true },
        { status: 200 }
      )
    }

    // Verify round is open
    const { data: round, error: roundError } = await sb
      .from('hl_rounds')
      .select('id, status, betting_closes_at')
      .eq('id', round_id)
      .single()

    if (roundError || !round) return badRequest('Round not found')
    if (round.status !== 'open') return Response.json(
      { success: false, error: 'Betting has closed for this round' },
      { status: 409 }
    )

    // Double-check timing server-side
    if (new Date(round.betting_closes_at) < new Date()) {
      return Response.json(
        { success: false, error: 'Betting window has expired' },
        { status: 409 }
      )
    }

    // Place bet via atomic RPC (handles balance check + lock + pool update)
    const { data, error } = await sb.rpc('hl_place_bet', {
      p_wallet:          wallet,
      p_amount:          amount,
      p_round_id:        round_id,
      p_side:            side,
      p_idempotency_key: idempotency_key,
    })

    if (error) {
      if (error.message.includes('insufficient_balance')) {
        return badRequest('Insufficient balance')
      }
      if (error.message.includes('one_bet_per_wallet_per_round')) {
        return Response.json(
          { success: false, error: 'You already have a bet on this round' },
          { status: 409 }
        )
      }
      if (error.message.includes('not open for betting')) {
        return Response.json(
          { success: false, error: 'Round is not open for betting' },
          { status: 409 }
        )
      }
      throw error
    }

    const result = data as { bet_id: string; balance_usdc: number }

    return ok({
      bet_id:       result.bet_id,
      round_id,
      side,
      amount,
      balance_usdc: result.balance_usdc,
    })
  } catch (e: any) {
    if (e.message?.includes('token') || e.message?.includes('wallet')) {
      return unauthorized(e.message)
    }
    return serverError(e)
  }
}
