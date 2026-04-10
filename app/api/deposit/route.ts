import { NextRequest } from 'next/server'
import { verifyAuth, unauthorized, ok, badRequest, serverError } from '@/lib/auth'
import { createServerSupabase } from '@/lib/supabase/server'
import { verifyUsdcDeposit } from '@/lib/deposit'

// Expose the on-chain destination for USDC deposits so the client can
// display it in the deposit modal. Read-only, no auth needed.
export async function GET() {
  try {
    const treasury = process.env.TREASURY_WALLET_ADDRESS ?? null
    return ok({
      treasury_wallet: treasury,
      chain: 'base',
      token: 'USDC',
      token_contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    })
  } catch (e: any) {
    return serverError(e)
  }
}

export async function POST(req: NextRequest) {
  try {
    const wallet = await verifyAuth(req)
    const body = await req.json()
    const { tx_hash, amount } = body

    if (!tx_hash) return badRequest('tx_hash required')
    if (!amount || amount <= 0) return badRequest('Invalid amount')
    if (amount < 1) return badRequest('Minimum deposit is $1 USDC')

    // Full on-chain verification
    let verifiedAmount: number
    try {
      verifiedAmount = await verifyUsdcDeposit(tx_hash, amount, wallet)
    } catch (e: any) {
      return badRequest(e.message)
    }

    // Credit balance via RPC
    const sb = createServerSupabase()
    const { data, error } = await sb.rpc('hl_credit_deposit', {
      p_wallet:  wallet,
      p_amount:  verifiedAmount,
      p_tx_hash: tx_hash,
    })

    if (error) throw error

    return ok({
      balance_usdc: Number(data),
      amount_credited: verifiedAmount,
      tx_hash,
    })
  } catch (e: any) {
    if (e.message?.includes('token') || e.message?.includes('wallet')) {
      return unauthorized(e.message)
    }
    return serverError(e)
  }
}
