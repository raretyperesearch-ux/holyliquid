import { NextRequest } from 'next/server'
import { verifyAuthFull, unauthorized, ok, badRequest, serverError } from '@/lib/auth'
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
    const auth = await verifyAuthFull(req)
    const body = await req.json()
    const { tx_hash, amount } = body

    if (!tx_hash || typeof tx_hash !== 'string') return badRequest('tx_hash required')
    if (!amount || amount <= 0) return badRequest('Invalid amount')
    if (amount < 1) return badRequest('Minimum deposit is $1 USDC')

    const sb = createServerSupabase()

    // ── Fast-path idempotency check: has this exact tx already been processed?
    // Wrapped so the deposit flow still works if hl_idempotency migration hasn't shipped yet.
    const idempotencyKey = `deposit:${tx_hash.toLowerCase()}`
    try {
      const { data: existing } = await sb
        .from('hl_idempotency')
        .select('status, response_payload')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle()

      if (existing && existing.status === 'completed' && existing.response_payload) {
        return ok(existing.response_payload)
      }
    } catch (e) {
      console.warn('[DEPOSIT] hl_idempotency pre-check failed (table may not exist yet):', e)
    }

    // ── Verify the on-chain tx against ALL of the user's linked wallets
    const allowedFroms = auth.linkedWallets.map(w => w.address)
    if (allowedFroms.length === 0) {
      return badRequest('No linked wallets on Privy account')
    }

    let verifiedAmount: number
    try {
      verifiedAmount = await verifyUsdcDeposit(tx_hash, amount, allowedFroms)
    } catch (e: any) {
      return badRequest(e.message)
    }

    // ── Credit balance via RPC. The unique constraint on hl_transactions.tx_hash
    // will reject any race-duplicate that slipped past the fast-path check above.
    const { data, error } = await sb.rpc('hl_credit_deposit', {
      p_wallet:  auth.primaryWallet,
      p_amount:  verifiedAmount,
      p_tx_hash: tx_hash,
    })

    if (error) {
      if (error.code === '23505' || error.message?.includes('hl_transactions_tx_hash_unique')) {
        return badRequest('This transaction has already been credited')
      }
      throw error
    }

    // Touch the user row (creates hl_users row if missing, bumps last_seen).
    // Silently skip if the RPC doesn't exist yet.
    try {
      await sb.rpc('hl_touch_user', { p_wallet: auth.primaryWallet })
    } catch (e) {
      console.warn('[DEPOSIT] hl_touch_user failed (RPC may not exist yet):', e)
    }

    const responsePayload = {
      balance_usdc: Number(data),
      amount_credited: verifiedAmount,
      tx_hash,
    }

    // ── Store idempotency record for future fast-path lookups
    try {
      await sb.from('hl_idempotency').upsert({
        idempotency_key: idempotencyKey,
        wallet: auth.primaryWallet,
        operation: 'deposit',
        status: 'completed',
        response_payload: responsePayload,
        tx_hash,
        completed_at: new Date().toISOString(),
      })
    } catch (e) {
      console.warn('[DEPOSIT] hl_idempotency write failed (table may not exist yet):', e)
    }

    return ok(responsePayload)
  } catch (e: any) {
    if (e.message?.includes('token') || e.message?.includes('wallet')) {
      return unauthorized(e.message)
    }
    return serverError(e)
  }
}
